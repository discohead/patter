// The public side of the Worker, in Node: who counts as the host, what a
// listener can reach, and how the OnAir object treats listeners. The
// platform's own pieces (Access in front, the Durable Object runtime) are
// stood in for; the broadcast's state is the real OnAirState.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnAirState, type OnAirKey } from '../../src/app/on-air';
import { emptyPatch } from '../../src/runtime/patch';
import { hostOf, verifyAccess } from '../access';
import { handlePublic, isPublic } from '../listen';
import { LISTENER_HEADER, MAX_LISTENERS, MAX_PER_ADDRESS, OnAir } from '../on-air';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'patter-aud';
const HASH = 'c'.repeat(64);

let keys: CryptoKeyPair;
const certs = vi.fn(async () => Response.json({ keys: [{ ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'key-1' }] }));

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  vi.stubGlobal('fetch', async (url: string) => (url === `https://${TEAM}/cdn-cgi/access/certs` ? certs() : new Response('nope', { status: 404 })));
});

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const part = (o: object) => b64(new TextEncoder().encode(JSON.stringify(o)));

/** An Access JWT for the host, signed with the team's key, with any claims changed. */
async function token(claims: Record<string, unknown> = {}, kid = 'key-1'): Promise<string> {
  const head = part({ alg: 'RS256', kid });
  const body = part({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email: 'host@example.com', ...claims });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(sig))}`;
}

// ── a stand-in environment, with the broadcast's real state behind its stub ──

let rows: Map<OnAirKey, string>;
let air: OnAirState;
let limited: Set<string>;
const forwarded: Request[] = [];
const r2 = new Map([[`owner-prefix/${HASH}`, { body: 'RIFF', size: 4, httpMetadata: { contentType: 'audio/wav' }, httpEtag: '"e1"' }]]);

function env(over: Record<string, unknown> = {}): Env {
  const stub = {
    fetch: async (r: Request) => {
      forwarded.push(r);
      return new Response('upgraded');
    },
    snapshot: async () => air.snapshot(),
    sampleOwner: async (hash: string) => air.sampleOwner(hash),
  };
  return {
    ACCESS_MODE: 'on',
    ACCESS_TEAM: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_EMAILS: 'host@example.com',
    LISTEN_LIMIT: { limit: async ({ key }: { key: string }) => ({ success: !limited.has(key.split(':')[0]) }) },
    OnAir: { getByName: () => stub },
    SAMPLES: { get: async (key: string) => r2.get(key) ?? null },
    ...over,
  } as unknown as Env;
}

beforeEach(() => {
  rows = new Map();
  air = new OnAirState({ get: (k) => rows.get(k) ?? null, put: (k, v) => void rows.set(k, v) });
  limited = new Set();
  forwarded.length = 0;
});

const get = (path: string, headers: Record<string, string> = {}) => new Request(`https://datspace.studio${path}`, { headers });
const whoami = async (headers: Record<string, string> = {}, e = env()) => (await (await handlePublic(get('/whoami', headers), e)).json()) as { host: boolean };

describe('who is the host', () => {
  it('is whoever carries a valid Access JWT for an allowed email, in the cookie or the header', async () => {
    expect(await whoami()).toEqual({ host: false });
    expect(await whoami({ cookie: `theme=dark; CF_Authorization=${await token()}` })).toEqual({ host: true });
    expect(await whoami({ 'cf-access-jwt-assertion': await token() })).toEqual({ host: true });
  });

  it('is no one with a token for someone else, for another application, expired, or signed by another key', async () => {
    expect(await whoami({ cookie: `CF_Authorization=${await token({ email: 'someone@example.com' })}` })).toEqual({ host: false });
    expect(await whoami({ cookie: `CF_Authorization=${await token({ aud: ['other-app'] })}` })).toEqual({ host: false });
    expect(await whoami({ cookie: `CF_Authorization=${await token({ exp: 1000 })}` })).toEqual({ host: false });
    expect(await whoami({ cookie: `CF_Authorization=${await token({}, 'key-2')}` })).toEqual({ host: false });
  });

  it("treats a token that doesn't parse as no one's, without failing", async () => {
    for (const bad of ['a.b.c', '!!!.???.***', `${part({ alg: 'none' })}.${part({})}.x`, 'onlyonepart']) {
      expect(await whoami({ cookie: `CF_Authorization=${bad}` })).toEqual({ host: false });
    }
  });

  it("doesn't fetch Access's keys again for every unknown key it's shown", async () => {
    await verifyAccess(get('/', { 'cf-access-jwt-assertion': await token() }), { team: TEAM, aud: AUD, allowed: ['host@example.com'] });
    const before = certs.mock.calls.length;
    for (let i = 0; i < 5; i++) await whoami({ cookie: `CF_Authorization=${await token({}, `key-${i + 9}`)}` });
    expect(certs.mock.calls.length - before).toBeLessThanOrEqual(1);
  });

  it('is everyone in local development (there is no Access in front)', async () => {
    expect(await whoami({}, env({ ACCESS_MODE: 'off' }))).toEqual({ host: true });
    expect(await hostOf(get('/'), { ACCESS_MODE: 'off', ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: '' })).toBe('dev');
  });
});

describe('what a listener can reach', () => {
  it('is only /whoami, /login and /listen*', () => {
    for (const p of ['/whoami', '/login', '/listen', '/listen/state', '/listen/samples/x']) expect(isPublic(p)).toBe(true);
    for (const p of ['/', '/api/library', '/api/on-air', '/agents/patter-agent/s-1', '/listener', '/whoami/x']) expect(isPublic(p)).toBe(false);
  });

  it('hands /listen to the OnAir object as a WebSocket, and nothing else', async () => {
    expect((await handlePublic(get('/listen'), env())).status).toBe(426);
    expect(forwarded).toHaveLength(0);
    const socket = { upgrade: 'websocket', origin: 'https://datspace.studio', 'cf-connecting-ip': '203.0.113.9' };
    expect(await (await handlePublic(get('/listen', socket), env())).text()).toBe('upgraded');
    expect(forwarded).toHaveLength(1);
    expect((await handlePublic(new Request('https://datspace.studio/listen/state', { method: 'POST', body: '{}' }), env())).status).toBe(405);
  });

  it('opens the WebSocket only for the page itself, so other sites can’t open them from their visitors’ browsers', async () => {
    expect((await handlePublic(get('/listen', { upgrade: 'websocket' }), env())).status).toBe(403);
    expect((await handlePublic(get('/listen', { upgrade: 'websocket', origin: 'https://example.com' }), env())).status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it('tells the OnAir object where a listener connects from as a hash, never the address', async () => {
    const from = async (ip: string) => {
      forwarded.length = 0;
      await handlePublic(get('/listen', { upgrade: 'websocket', origin: 'https://datspace.studio', 'cf-connecting-ip': ip }), env());
      return forwarded[0].headers.get(LISTENER_HEADER)!;
    };
    const a = await from('203.0.113.9');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain('203');
    expect(await from('203.0.113.9')).toBe(a);
    expect(await from('198.51.100.7')).not.toBe(a);
  });

  it('serves what is on air as JSON', async () => {
    air.publish({ publisher: 'tab-aaaaaaaa', live: true, session: 's-one', title: 'dub', doc: emptyPatch(), transcript: [] }, 'owner-prefix');
    const body = (await (await handlePublic(get('/listen/state'), env())).json()) as { status: { live: boolean; session: string } };
    expect(body.status).toMatchObject({ live: true, session: 's-one' });
  });

  it('serves a library sample only while the patch on air plays it', async () => {
    const sample = () => handlePublic(get(`/listen/samples/${HASH}`), env());
    expect((await sample()).status).toBe(404);
    const doc = emptyPatch();
    doc.samples.loop = { src: `lib:${HASH}`, channels: 1, frames: 4, duration: 1 };
    air.publish({ publisher: 'tab-aaaaaaaa', live: true, session: 's-one', doc }, 'owner-prefix');
    const res = await sample();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('RIFF');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    air.publish({ publisher: 'tab-aaaaaaaa', doc: emptyPatch() }, 'owner-prefix');
    expect((await sample()).status).toBe(404);
    expect((await handlePublic(get('/listen/samples/not-a-hash'), env())).status).toBe(404);
  });

  it('is rate limited per kind of request', async () => {
    limited.add('socket');
    expect((await handlePublic(get('/listen', { upgrade: 'websocket' }), env())).status).toBe(429);
    expect((await handlePublic(get('/whoami'), env())).status).toBe(200);
    limited.add('whoami');
    expect((await handlePublic(get('/whoami'), env())).status).toBe(429);
  });

  it('sends /login back to the page (Access signs the host in on the way)', async () => {
    const res = await handlePublic(get('/login'), env());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://datspace.studio/');
  });
});

// ── the OnAir object, with a stand-in for its state and sockets ──

class Socket {
  sent: string[] = [];
  closed: [number, string] | null = null;
  send(m: string) {
    this.sent.push(m);
  }
  close(code: number, reason: string) {
    this.closed = [code, reason];
  }
}

function onAirObject() {
  const kv = new Map<string, string>();
  const sockets: Socket[] = [];
  const tags = new Map<Socket, string[]>();
  const ctx = {
    storage: {
      sql: {
        exec(query: string, ...args: string[]) {
          if (query.startsWith('SELECT')) return { toArray: () => (kv.has(args[0]) ? [{ value: kv.get(args[0]) }] : []) };
          if (query.startsWith('INSERT')) kv.set(args[0], args[1]);
          return { toArray: () => [] };
        },
      },
      transactionSync: <T>(fn: () => T) => fn(),
    },
    setWebSocketAutoResponse() {},
    getWebSockets: (tag?: string) => (tag === undefined ? sockets : sockets.filter((s) => tags.get(s)?.includes(tag))),
    acceptWebSocket(ws: Socket, t: string[] = []) {
      sockets.push(ws);
      tags.set(ws, t);
    },
  };
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
  return { object: new OnAir(ctx as unknown as DurableObjectState, {} as Env), sockets, tags };
}

describe('the OnAir object', () => {
  it('sends every listener what the host publishes, and nothing when it refuses', () => {
    const { object, sockets } = onAirObject();
    sockets.push(new Socket(), new Socket());
    expect(object.publish({ publisher: 'tab-aaaaaaaa', live: true, session: 's-one', title: 'dub', doc: emptyPatch() }, 'owner-prefix')).toMatchObject({ ok: true });
    for (const s of sockets) expect(s.sent.map((m) => JSON.parse(m).type)).toEqual(['status', 'patch', 'transcript']);
    expect(object.publish({ publisher: 'tab-bbbbbbbb', stopped: true }, 'owner-prefix')).toEqual({ ok: false, reason: 'elsewhere' });
    for (const s of sockets) expect(s.sent).toHaveLength(3);
    expect(object.host('tab-aaaaaaaa')).toMatchObject({ mine: true, listeners: 2 });
    expect(object.host('tab-bbbbbbbb')).toMatchObject({ mine: false });
  });

  it('has room for an audience, but not for anyone hoarding sockets', async () => {
    const { object, sockets, tags } = onAirObject();
    const knock = (from: string) => object.fetch(new Request('https://datspace.studio/listen', { headers: { upgrade: 'websocket', [LISTENER_HEADER]: from } }));
    for (let i = 0; i < MAX_PER_ADDRESS; i++) {
      const s = new Socket();
      sockets.push(s);
      tags.set(s, ['busy']);
    }
    expect((await knock('busy')).status).toBe(503);
    while (sockets.length < MAX_LISTENERS) sockets.push(new Socket());
    expect((await knock('someone-else')).status).toBe(503);
  });

  it("doesn't take anything from a listener: whatever one sends ends its connection", () => {
    const { object, sockets } = onAirObject();
    const listener = new Socket();
    sockets.push(listener);
    object.webSocketMessage(listener as unknown as WebSocket);
    expect(listener.closed).toEqual([1008, 'listeners only listen']);
    expect(object.snapshot().status.session).toBeNull();
  });
});
