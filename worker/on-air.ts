// The broadcast, in one Durable Object ("on-air"). It owns what's on air:
// which session and its title, its latest patch, its conversation as of the
// host's last finished turn, the host's tempo and transport, whether it's
// live and since when. It also coordinates the listeners: their WebSockets
// are held through the Hibernation API, so an audience that's only listening
// costs nothing between changes. Only the host writes (RPC from the Worker's
// /api/on-air, behind Access); listeners only receive. Off air, everything
// stays, so a listener who comes by still gets a patch to play.

import { DurableObject } from 'cloudflare:workers';
import { OnAirState, type OnAirRefusal, type OnAirSnapshot, type OnAirStatus, type OnAirUpdate } from '../src/app/on-air';

/** The Worker tags each listener with a hash of where it connects from (never the address itself). */
export const LISTENER_HEADER = 'x-patter-listener';
/** Room for an audience, not for someone hoarding sockets: each update goes to every one of them. */
export const MAX_LISTENERS = 2000;
export const MAX_PER_ADDRESS = 32;

export class OnAir extends DurableObject<Env> {
  private readonly state: OnAirState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS on_air (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.state = new OnAirState({
      get: (key) => sql.exec<{ value: string }>('SELECT value FROM on_air WHERE key = ?', key).toArray()[0]?.value ?? null,
      put: (key, value) => {
        sql.exec('INSERT OR REPLACE INTO on_air (key, value) VALUES (?, ?)', key, value);
      },
    });
    // Keep-alive pings are answered without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** A listener tunes in (GET /listen, upgraded by the Worker): what's on air now, then every change. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
    const from = request.headers.get(LISTENER_HEADER) ?? 'unknown';
    if (this.ctx.getWebSockets().length >= MAX_LISTENERS || this.ctx.getWebSockets(from).length >= MAX_PER_ADDRESS) {
      return new Response('too many listeners: try again in a while', { status: 503 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [from]);
    for (const m of this.state.welcome()) server.send(m);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Listeners don't write. Their page only sends 'ping', answered above
   * without reaching here; anything else ends the connection, so no one can
   * keep this object awake (and billed) by talking to it.
   */
  webSocketMessage(ws: WebSocket): void {
    ws.close(1008, 'listeners only listen');
  }

  // ── RPC from the Worker ──────────────────────────────────────────────────

  /** The host's update (the Worker has checked Access): kept, then sent to every listener. */
  publish(update: OnAirUpdate, owner: string): { ok: true; status: OnAirStatus; listeners: number } | OnAirRefusal {
    const r = this.ctx.storage.transactionSync(() => this.state.publish(update, owner));
    if (!r.ok) return r;
    const listeners = this.ctx.getWebSockets();
    for (const ws of listeners) {
      try {
        for (const m of r.messages) ws.send(m);
      } catch {
        /* closing as we speak */
      }
    }
    return { ok: true, status: r.status, listeners: listeners.length };
  }

  /** For the host's page: what's on air, whether it's that tab broadcasting, and how many are listening. */
  host(publisher: string): { status: OnAirStatus; mine: boolean; listeners: number } {
    return { status: this.state.status(), mine: this.state.isPublisher(publisher), listeners: this.ctx.getWebSockets().length };
  }

  snapshot(): OnAirSnapshot {
    return this.state.snapshot();
  }

  /** The R2 prefix holding a library sample, while the patch on air plays it. */
  sampleOwner(hash: string): string | null {
    return this.state.sampleOwner(hash);
  }
}
