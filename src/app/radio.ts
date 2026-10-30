// Listening: a page that isn't the host's tunes in to the broadcast over a
// WebSocket (GET /listen). It's sent everything on connect (the status, the
// patch, the conversation), then each change. Following, the default, the
// host's patch replaces this page's as it changes, in place: what's the same
// keeps playing, knobs turned here included. Detached, the changes wait, and
// rejoining brings the newest. Nothing goes back to the host.

import type { PatchDoc } from '../runtime/patch';
import type { OnAirMessage, OnAirStatus, TranscriptMessage } from './on-air';

/** What the radio needs from the page it's in. */
export interface Tuner {
  /** Play this patch: in place of what's playing, changing only what differs. */
  play(doc: PatchDoc): Promise<void>;
  /** The host stopped (or started) the sound. */
  transport(stopped: boolean): void;
  changed(): void;
}

const PING_MS = 45_000;

export class Radio {
  /** What's on air; null until the broadcast has answered. */
  status: OnAirStatus | null = null;
  transcript: TranscriptMessage[] = [];
  /** The host's newest patch. */
  latest: { session: string; doc: PatchDoc; updatedAt: number } | null = null;
  /** Following the host's changes (or detached, with `missed` of them waiting). */
  following = true;
  missed = 0;
  connection: 'connecting' | 'open' | 'lost' = 'connecting';
  /** Audio runs, so patches can play. */
  private running = false;
  /** The patch playing here (its updatedAt). */
  private applied = 0;
  /** Patches go in one at a time: the one going in now, and at most one more waiting (which takes the newest). */
  private queue: Promise<void> = Promise.resolve();
  private waiting = false;
  /** The next one goes in even if it's the patch already playing (rejoining puts back the host's knobs). */
  private force = false;
  private retries = 0;

  constructor(private readonly tuner: Tuner) {}

  connect(): void {
    const url = new URL('/listen', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    let ping: ReturnType<typeof setInterval> | null = null;
    this.connection = 'connecting';
    ws.onopen = () => {
      this.connection = 'open';
      this.retries = 0;
      // Answered by the runtime without waking the broadcast; keeps idle connections from being dropped on the way.
      ping = setInterval(() => ws.send('ping'), PING_MS);
      this.tuner.changed();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data === 'pong') return;
      try {
        this.receive(JSON.parse(e.data) as OnAirMessage);
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      this.connection = 'lost';
      this.tuner.changed();
      setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** this.retries++) + Math.random() * 1000);
    };
  }

  receive(m: OnAirMessage): void {
    if (m.type === 'status') {
      const was = this.status;
      this.status = m.status;
      // The host stopped or started the sound, so does this page (and if audio started here before the
      // broadcast answered, a host who's stopped stops it).
      const turned = was ? was.stopped !== m.status.stopped : m.status.stopped;
      if (turned && this.following && this.running) this.tuner.transport(m.status.stopped);
    } else if (m.type === 'patch') {
      if (m.updatedAt === this.latest?.updatedAt && m.session === this.latest.session) return; // a reconnect's welcome
      this.latest = { session: m.session, doc: m.doc, updatedAt: m.updatedAt };
      if (!this.following) this.missed++;
      else void this.apply();
    } else if (m.type === 'transcript') {
      this.transcript = m.messages;
    }
    this.tuner.changed();
  }

  /** Audio runs: play what's on air (even detached: a page needs a patch), and from now on each change. */
  start(): Promise<void> {
    this.running = true;
    return this.apply(true);
  }

  /** Follow the host again (the newest patch, the host's knobs, the host's transport), or keep this page's own. */
  async follow(on: boolean): Promise<void> {
    this.following = on;
    this.tuner.changed();
    if (!on) return;
    this.missed = 0;
    await this.apply(true);
    if (this.status && this.running) this.tuner.transport(this.status.stopped);
  }

  /** There's a newer patch than the one playing here. */
  get behind(): boolean {
    return Boolean(this.latest && this.latest.updatedAt !== this.applied);
  }

  /** Play the newest patch, after the one going in now (if any); of those that arrive meanwhile, only the newest. */
  private apply(force = false): Promise<void> {
    this.force ||= force;
    if (!this.running || !this.latest || this.waiting) return this.queue;
    this.waiting = true;
    this.queue = this.queue
      .then(async () => {
        this.waiting = false;
        const target = this.latest!;
        const forced = this.force;
        this.force = false;
        if (!forced && (!this.following || target.updatedAt === this.applied)) return;
        try {
          await this.tuner.play(target.doc);
        } finally {
          this.applied = target.updatedAt;
          this.tuner.changed();
        }
      })
      .catch(() => {
        /* the page says what went wrong; the next change tries again */
      });
    return this.queue;
  }
}

/**
 * The host's patch, with the knobs this page's own routines are turning left
 * where they are. The same routine turns them on both pages, at different
 * points in the bar, so the host's snapshot of a moving knob would only yank
 * it back until the routine's next step. `turning` holds 'module.param' and
 * 'macro:name' refs; neither document is changed.
 */
export function keepTurning(next: PatchDoc, here: PatchDoc, turning: Set<string>): PatchDoc {
  if (!turning.size) return next;
  const out: PatchDoc = { ...next, modules: { ...next.modules }, macros: { ...next.macros } };
  for (const key of turning) {
    if (key.startsWith('macro:')) {
      const name = key.slice(6);
      if (out.macros[name] && here.macros[name]) out.macros[name] = { ...out.macros[name], value: here.macros[name].value };
      continue;
    }
    const dot = key.lastIndexOf('.');
    const [module, param] = [key.slice(0, dot), key.slice(dot + 1)];
    const theirs = out.modules[module];
    const mine = here.modules[module];
    if (!theirs || !mine) continue;
    const params = { ...theirs.params };
    if (mine.params[param] === undefined) delete params[param];
    else params[param] = mine.params[param];
    out.modules[module] = { ...theirs, params };
  }
  return out;
}

/** Library samples the broadcast didn't have, and when that turned out: asked for again only after a while. */
const missing = new Map<string, number>();
const MISSING_MS = 2 * 60_000;

/**
 * A sample from the host's library, for a listener: through the broadcast,
 * which may not have it the moment the patch arrives (the host's upload can
 * trail the patch by a few seconds), so it asks a few times. One it still
 * doesn't have (an upload that failed) isn't asked for again for a while,
 * so every change to the patch doesn't wait on it.
 */
export async function broadcastSample(hash: string): Promise<Response> {
  const since = missing.get(hash);
  if (since !== undefined && Date.now() - since < MISSING_MS) return new Response('not on air', { status: 404 });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`/listen/samples/${hash}`);
    if (res.ok) {
      missing.delete(hash);
      return res;
    }
    if (attempt === 3 || (res.status !== 404 && res.status !== 429 && res.status < 500)) {
      if (res.status === 404) missing.set(hash, Date.now());
      return res;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}
