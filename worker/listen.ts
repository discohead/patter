// What anyone can reach: who's asking, and the broadcast.
//
//   GET /whoami                    { host }: is this the host (a valid Access JWT for an allowed email)?
//   GET /login                     back to the page; Access, in front of this path, signs the host in
//   GET /listen                    a WebSocket: what's on air now, then every change
//   GET /listen/state              what's on air now, as JSON
//   GET /listen/samples/:sha256    a sample from the host's library, while the patch on air plays it
//
// None of it reaches the model, the library, or anything that writes. Every
// path but /login (which Access guards) is rate limited per IP.

import { hostOf } from './access';

const SAMPLE = /^\/listen\/samples\/([0-9a-f]{64})$/;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const text = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });

export function isPublic(path: string): boolean {
  return path === '/whoami' || path === '/login' || path === '/listen' || path.startsWith('/listen/');
}

export async function handlePublic(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== 'GET') return text('method not allowed', 405);
  if (path === '/login') return Response.redirect(new URL('/', url).toString(), 302);

  // One counter per kind of request, per IP, per Cloudflare location: a page needs a handful of each.
  const kind = path === '/whoami' ? 'whoami' : path === '/listen' ? 'socket' : path === '/listen/state' ? 'state' : 'sample';
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await env.LISTEN_LIMIT.limit({ key: `${kind}:${ip}` })).success) return text('too many requests: try again in a minute', 429);

  if (path === '/whoami') return json({ host: (await hostOf(request, env)) !== null });
  const onAir = env.OnAir.getByName('on-air');
  if (path === '/listen') {
    if (request.headers.get('Upgrade') !== 'websocket') return text('expected a WebSocket', 426);
    return onAir.fetch(request);
  }
  if (path === '/listen/state') return json(await onAir.snapshot());
  const hash = SAMPLE.exec(path)?.[1];
  if (!hash) return text('not found', 404);
  const owner = await onAir.sampleOwner(hash);
  if (!owner) return text('not on air', 404);
  const obj = await env.SAMPLES.get(`${owner}/${hash}`);
  if (!obj) return text('no such sample', 404);
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'content-length': String(obj.size),
      // Named by content, so it never changes; kept by the listener's browser only.
      'cache-control': 'private, max-age=31536000, immutable',
      etag: obj.httpEtag,
    },
  });
}
