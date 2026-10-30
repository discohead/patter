// /api: the library over HTTP, for the signed-in person only (the Worker has
// already checked their Access identity; their library is the Durable Object
// named after it, and their sessions' conversations are PatterAgents).
//
//   GET    /api/library                          the tree: your AGENTS.md, sets, songs, sessions
//   PUT    /api/context                          { agents }: your AGENTS.md
//   POST   /api/sets                             { name }
//   PUT    /api/sets/:id                         { name?, agents? }
//   DELETE /api/sets/:id[?cascade=1]             its songs move to the top (or go, with their sessions)
//   POST   /api/songs                            { name, setId? }
//   PUT    /api/songs/:id                        { name?, agents?, setId?, position? }
//   DELETE /api/songs/:id[?cascade=1]            its sessions move to the top (or go)
//   POST   /api/sessions                         { name, songId?, doc }: a new session
//   GET    /api/sessions/:name                   its latest patch and its place
//   PUT    /api/sessions/:name                   { doc, updated, turns? }: autosave
//   PATCH  /api/sessions/:name                   { title?, songId? }: rename, move
//   DELETE /api/sessions/:name                   the session and its conversation
//   POST   /api/sessions/:name/fork              { at?, keep, checkpoint?, title?, songId?, doc? }: a branch
//   GET    /api/sessions/:name/checkpoints       its checkpoints (no patches)
//   POST   /api/sessions/:name/checkpoints       { at, kind, label?, doc }
//   GET    /api/sessions/:name/checkpoints/:id   one, with its patch
//   GET    /api/samples                          the audio files in the library
//   PUT    /api/samples/:sha256                  upload one (the body is the file; its SHA-256 is the key)
//   GET    /api/samples/:sha256                  download one
//   DELETE /api/samples/:sha256

import { getAgentByName } from 'agents';
import type { CheckpointKind, Conversation } from './agent';
import { MAX_AGENTS_CHARS, MAX_DOC_CHARS, type ForkKeep, type PatchLibrary } from './library';

const SHA256 = /^[0-9a-f]{64}$/;
/** Workers take request bodies up to 100 MB; a sample is RAM in the engine, so keep them sane. */
const MAX_SAMPLE_BYTES = 64 * 1024 * 1024;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** R2 keys carry a hash of the person, not their email. */
async function userPrefix(user: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`patter:${user}`))).slice(0, 24);
}

const SESSION = /^s-([0-9a-f-]{36}|ephemeral)$/;
const SET_ID = /^set-[0-9a-f-]{36}$/;
const SONG_ID = /^song-[0-9a-f-]{36}$/;
const MESSAGE_ID = /^[\w-]{1,100}$/;
const UUID = /^[0-9a-f-]{36}$/;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, message: string) => json({ error: message }, status);

function validName(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 120 ? v.trim() : null;
}

function validAgents(v: unknown): string | null {
  return typeof v === 'string' && v.length <= MAX_AGENTS_CHARS ? v : null;
}

/** A patch document, as text: a JSON object with a modules map, within the size limit. */
function validDoc(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const doc = v as { modules?: unknown };
  if (!doc.modules || typeof doc.modules !== 'object') return null;
  const text = JSON.stringify(v);
  return text.length <= MAX_DOC_CHARS ? text : null;
}

/** A song id, null (the top level), or undefined (not given / not valid). */
function songRef(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === 'string' && SONG_ID.test(v) ? v : undefined;
}

const agent = (env: Env, name: string) => getAgentByName(env.PatterAgent, name);

export async function handleApi(request: Request, env: Env, user: string): Promise<Response> {
  const url = new URL(request.url);
  const [, , resource, key, sub, subKey, ...rest] = url.pathname.split('/');
  if (rest.length) return fail(404, 'not found');
  // Writes must be JSON (or carry our header): either forces a CORS preflight
  // that cross-site pages can't pass, so only this app can write.
  if (request.method !== 'GET' && request.headers.get('content-type') !== 'application/json' && request.headers.get('x-patter') !== '1') {
    return fail(415, 'send JSON');
  }
  const lib = env.PatchLibrary.get(env.PatchLibrary.idFromName(user));
  const body = async () => {
    try {
      return (await request.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const cascade = url.searchParams.get('cascade') === '1';
  const wipe = async (sessions: string[]) => {
    for (const s of sessions) await (await agent(env, s)).wipe().catch(() => {});
  };
  const method = request.method;

  if (resource === 'library' && !key && method === 'GET') return json(await lib.tree());

  if (resource === 'context' && !key && method === 'PUT') {
    const agents = validAgents((await body())?.agents);
    if (agents === null) return fail(400, `needs agents: text, at most ${MAX_AGENTS_CHARS} characters`);
    await lib.setUserAgents(agents);
    return json({ saved: true });
  }

  if (resource === 'sets' && !sub) {
    if (!key) {
      if (method !== 'POST') return fail(405, 'POST a set');
      const name = validName((await body())?.name);
      return name ? json(await lib.createSet(name), 201) : fail(400, 'needs a name');
    }
    if (!SET_ID.test(key)) return fail(404, 'no such set');
    if (method === 'PUT') {
      const b = await body();
      const name = b?.name === undefined ? undefined : validName(b.name);
      const agents = b?.agents === undefined ? undefined : validAgents(b.agents);
      if (name === null || agents === null) return fail(400, 'a name (1–120 characters) or agents text');
      return (await lib.updateSet(key, { name, agents })) ? json({ saved: key }) : fail(404, 'no such set');
    }
    if (method === 'DELETE') {
      const r = await lib.deleteSet(key, cascade);
      await wipe(r.sessions);
      return r.deleted ? json({ deleted: key, sessions: r.sessions }) : fail(404, 'no such set');
    }
    return fail(405, 'method not allowed');
  }

  if (resource === 'songs' && !sub) {
    if (!key) {
      if (method !== 'POST') return fail(405, 'POST a song');
      const b = await body();
      const name = validName(b?.name);
      const setId = b?.setId === undefined || b.setId === null ? null : typeof b.setId === 'string' && SET_ID.test(b.setId) ? b.setId : undefined;
      if (!name || setId === undefined) return fail(400, 'needs a name (and a set id, if any)');
      try {
        return json(await lib.createSong(name, setId), 201);
      } catch (e) {
        return fail(404, (e as Error).message);
      }
    }
    if (!SONG_ID.test(key)) return fail(404, 'no such song');
    if (method === 'PUT') {
      const b = await body();
      const name = b?.name === undefined ? undefined : validName(b.name);
      const agents = b?.agents === undefined ? undefined : validAgents(b.agents);
      const setId = b?.setId === undefined ? undefined : b.setId === null ? null : typeof b.setId === 'string' && SET_ID.test(b.setId) ? b.setId : false;
      const position = typeof b?.position === 'number' && Number.isFinite(b.position) ? b.position : undefined;
      if (name === null || agents === null || setId === false) return fail(400, 'a name, agents text, a set id (or null) or a position');
      try {
        return (await lib.updateSong(key, { name, agents, setId, position })) ? json({ saved: key }) : fail(404, 'no such song');
      } catch (e) {
        return fail(404, (e as Error).message);
      }
    }
    if (method === 'DELETE') {
      const r = await lib.deleteSong(key, cascade);
      await wipe(r.sessions);
      return r.deleted ? json({ deleted: key, sessions: r.sessions }) : fail(404, 'no such song');
    }
    return fail(405, 'method not allowed');
  }

  if (resource === 'sessions') {
    if (!key) {
      if (method !== 'POST') return fail(405, 'POST a session');
      const b = await body();
      const name = typeof b?.name === 'string' && SESSION.test(b.name) ? b.name : `s-${crypto.randomUUID()}`;
      const doc = validDoc(b?.doc);
      const songId = b?.songId === undefined ? null : songRef(b.songId);
      if (!doc || songId === undefined) return fail(400, 'needs a patch document (and a song id, if any)');
      if (await lib.hasSession(name)) return fail(409, 'that session exists');
      try {
        return json(await lib.createSession({ name, doc, songId }), 201);
      } catch (e) {
        return fail(404, (e as Error).message);
      }
    }
    if (!SESSION.test(key)) return fail(404, 'no such session');
    if (!sub) return session(request, env, lib, key, body);
    if (!(await lib.hasSession(key))) return fail(404, 'no such session');
    if (sub === 'fork' && !subKey && method === 'POST') return fork(env, lib, key, await body());
    if (sub === 'checkpoints') {
      const stub = await agent(env, key);
      if (!subKey) {
        if (method === 'GET') return json(await stub.listCheckpoints());
        if (method !== 'POST') return fail(405, 'GET or POST checkpoints');
        const b = await body();
        const kind = b?.kind === 'after' || b?.kind === 'manual' ? (b.kind as CheckpointKind) : null;
        const at = b?.at === null || b?.at === undefined ? null : typeof b.at === 'string' && MESSAGE_ID.test(b.at) ? b.at : undefined;
        const doc = validDoc(b?.doc);
        const label = typeof b?.label === 'string' ? b.label.trim().slice(0, 120) || null : null;
        if (!kind || at === undefined || !doc || (kind === 'after' && !at)) return fail(400, "needs kind ('after' with the message it ends, or 'manual'), and a patch document");
        return json(await stub.putCheckpoint({ at, kind, label, doc }), 201);
      }
      if (!UUID.test(subKey) || method !== 'GET') return fail(404, 'no such checkpoint');
      const k = await stub.getCheckpoint(subKey);
      return k ? json({ ...k, doc: JSON.parse(k.doc) }) : fail(404, 'no such checkpoint');
    }
    return fail(404, 'not found');
  }

  if (resource === 'samples' && !sub) return handleSamples(request, env, user, key, lib);

  return fail(404, 'not found');
}

async function session(request: Request, env: Env, lib: DurableObjectStub<PatchLibrary>, name: string, body: () => Promise<Record<string, unknown> | null>): Promise<Response> {
  const method = request.method;
  if (method === 'GET') {
    const s = await lib.getSession(name);
    return s ? json({ ...s, doc: JSON.parse(s.doc) }) : fail(404, 'no such session');
  }
  if (method === 'PUT') {
    const b = await body();
    const doc = validDoc(b?.doc);
    if (!doc) return fail(400, 'not a patch document (or over 1.9 MB)');
    const updated = typeof b?.updated === 'number' && Number.isFinite(b.updated) ? b.updated : Date.now();
    const turns = typeof b?.turns === 'number' && Number.isFinite(b.turns) ? Math.max(0, Math.round(b.turns)) : null;
    await lib.putSession(name, doc, updated, turns);
    return json({ saved: name });
  }
  if (method === 'PATCH') {
    const b = await body();
    if (b?.title !== undefined) {
      const title = validName(b.title);
      if (!title) return fail(400, 'a title is 1–120 characters');
      if (!(await lib.renameSession(name, title))) return fail(404, 'no such session');
    }
    if (b?.songId !== undefined) {
      const songId = songRef(b.songId);
      if (songId === undefined) return fail(400, 'songId: a song id, or null for the top level');
      try {
        if (!(await lib.moveSession(name, songId))) return fail(404, 'no such session');
      } catch (e) {
        return fail(404, (e as Error).message);
      }
    }
    return json({ saved: name });
  }
  if (method === 'DELETE') {
    const known = await lib.deleteSession(name);
    await (await agent(env, name)).wipe().catch(() => {});
    return known ? json({ deleted: name }) : fail(404, 'no such session');
  }
  return fail(405, 'method not allowed');
}

/**
 * A branch: a new session with the conversation of `from` up to a message
 * and the patch as it was there.
 *   keep 'before' — the messages before `at` (to send a different one there: edit, retry)
 *   keep 'after'  — up to and including `at` (to go on differently from that answer)
 *   keep 'all'    — everything (a copy that goes its own way from here)
 *   keep 'none'   — no conversation, the patch as it is now (a fresh start)
 * With `checkpoint`, from that checkpoint: its patch, and the conversation up to where it was made.
 */
async function fork(env: Env, lib: DurableObjectStub<PatchLibrary>, from: string, b: Record<string, unknown> | null): Promise<Response> {
  const src = await lib.getSession(from);
  if (!src) return fail(404, 'no such session');
  let keep = b?.keep as ForkKeep;
  if (!['before', 'after', 'all', 'none'].includes(keep)) return fail(400, "keep: 'before', 'after', 'all' or 'none'");
  let at = typeof b?.at === 'string' && MESSAGE_ID.test(b.at) ? b.at : null;
  if ((keep === 'before' || keep === 'after') && !at) return fail(400, 'say at which message (at)');
  const title = b?.title === undefined ? null : validName(b.title);
  const songId = b?.songId === undefined ? src.songId : songRef(b.songId);
  if (songId === undefined) return fail(400, 'songId: a song id, or null for the top level');
  const given = b?.doc === undefined ? null : validDoc(b.doc);

  const checkpoint = typeof b?.checkpoint === 'string' && UUID.test(b.checkpoint) ? b.checkpoint : null;
  const conv: Conversation = keep === 'none' && !checkpoint ? { messages: [], states: [], checkpoints: [] } : await (await agent(env, from)).exportConversation();
  // A whole copy is a branch after its last message.
  if (keep === 'all') {
    at = conv.messages[conv.messages.length - 1]?.id ?? null;
    keep = at ? 'after' : 'none';
  }
  let messages = conv.messages;
  let doc: string | null = null;
  let approximate = false;
  if (checkpoint) {
    const k = conv.checkpoints.find((x) => x.id === checkpoint);
    if (!k) return fail(404, 'no such checkpoint');
    doc = k.doc;
    at = k.at;
    keep = at && messages.some((m) => m.id === at) ? 'after' : 'none';
    if (keep === 'none') messages = [];
  }
  if (keep === 'before' || keep === 'after') {
    const i = messages.findIndex((m) => m.id === at);
    if (i < 0) return fail(400, 'that message is not in the session');
    messages = messages.slice(0, keep === 'before' ? i : i + 1);
    if (!doc) {
      const own = conv.checkpoints.find((k) => k.at === at && k.kind === keep);
      // After a turn and before the next message: the same patch, give or take a knob.
      const next = keep === 'after' ? conv.messages[i + 1] : undefined;
      const fallback = next && conv.checkpoints.find((k) => k.at === next.id && k.kind === 'before');
      doc = own?.doc ?? fallback?.doc ?? null;
      // From before checkpoints were kept: the patch as it is now.
      approximate = !doc;
    }
  }
  doc ??= given ?? src.doc;

  const name = `s-${crypto.randomUUID()}`;
  const ids = new Set(messages.map((m) => m.id));
  try {
    await lib.createSession({
      name, doc, songId, parent: from, forkAt: at, forkKeep: keep, prefix: messages.length,
      turns: messages.filter((m) => m.role === 'user').length,
    });
  } catch (e) {
    return fail(404, (e as Error).message);
  }
  if (title) await lib.renameSession(name, title);
  if (messages.length) {
    await (await agent(env, name)).importConversation({
      messages,
      states: conv.states.filter((s) => ids.has(s.message_id)),
      checkpoints: conv.checkpoints.filter((k) => k.at !== null && ids.has(k.at)),
    });
  }
  const created = (await lib.getSession(name))!;
  return json({ session: { ...created, doc: JSON.parse(created.doc) }, approximate }, 201);
}

async function handleSamples(request: Request, env: Env, user: string, key: string | undefined, lib: DurableObjectStub<PatchLibrary>): Promise<Response> {
  if (!key) return request.method === 'GET' ? json(await lib.listSamples()) : fail(405, 'GET the list, or PUT /api/samples/:sha256');
  if (!SHA256.test(key)) return fail(404, 'no such sample');
  const objectKey = `${await userPrefix(user)}/${key}`;

  if (request.method === 'GET') {
    if (!(await lib.hasSample(key))) return fail(404, 'no such sample');
    const obj = await env.SAMPLES.get(objectKey);
    if (!obj) return fail(404, 'no such sample');
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'content-length': String(obj.size),
        // Named by content: it never changes.
        'cache-control': 'private, max-age=31536000, immutable',
        etag: obj.httpEtag,
      },
    });
  }

  if (request.method === 'PUT') {
    const declared = Number(request.headers.get('content-length') ?? 'NaN');
    if (declared > MAX_SAMPLE_BYTES) return fail(413, `samples can be at most ${MAX_SAMPLE_BYTES / 1024 / 1024} MB`);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) return fail(400, 'empty file');
    if (bytes.byteLength > MAX_SAMPLE_BYTES) return fail(413, `samples can be at most ${MAX_SAMPLE_BYTES / 1024 / 1024} MB`);
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== key) return fail(400, "the file's SHA-256 doesn't match the URL");
    const url = new URL(request.url);
    const name = (url.searchParams.get('name') ?? 'sample').slice(0, 120);
    const mime = (request.headers.get('x-sample-type') ?? 'application/octet-stream').slice(0, 80);
    const duration = Number(url.searchParams.get('duration') ?? '0') || 0;
    const channels = Math.max(0, Math.min(64, Math.round(Number(url.searchParams.get('channels') ?? '0') || 0)));
    if (!(await env.SAMPLES.head(objectKey))) {
      await env.SAMPLES.put(objectKey, bytes, { httpMetadata: { contentType: mime }, customMetadata: { name } });
    }
    return json(await lib.putSample({ hash: key, name, bytes: bytes.byteLength, mime, duration, channels }), 201);
  }

  if (request.method === 'DELETE') {
    const known = await lib.deleteSample(key);
    await env.SAMPLES.delete(objectKey);
    return known ? json({ deleted: key }) : fail(404, 'no such sample');
  }
  return fail(405, 'method not allowed');
}
