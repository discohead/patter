// /api: the patch library over HTTP, for the signed-in person only (the
// Worker has already checked their Access identity; their library is the
// Durable Object named after it).
//
//   GET    /api/library            saved patches and recent sessions
//   GET    /api/patches/:id        one saved patch
//   POST   /api/patches            save { name, doc } as a new patch
//   PUT    /api/patches/:id        update { name, doc? }
//   DELETE /api/patches/:id
//   GET    /api/sessions/:name     a session's working patch
//   PUT    /api/sessions/:name     { doc, libraryId, dirty, updated }
//   DELETE /api/sessions/:name

import { MAX_DOC_CHARS } from './library';

const PATCH_ID = /^p-[0-9a-f-]{36}$/;
const SESSION = /^s-([0-9a-f-]{36}|ephemeral)$/;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, message: string) => json({ error: message }, status);

function validName(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 120 ? v.trim() : null;
}

/** A patch document, as text: a JSON object with a modules map, within the size limit. */
function validDoc(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const doc = v as { modules?: unknown };
  if (!doc.modules || typeof doc.modules !== 'object') return null;
  const text = JSON.stringify(v);
  return text.length <= MAX_DOC_CHARS ? text : null;
}

export async function handleApi(request: Request, env: Env, user: string): Promise<Response> {
  const url = new URL(request.url);
  const [, , resource, key, ...rest] = url.pathname.split('/');
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

  if (resource === 'library' && !key && request.method === 'GET') return json(await lib.list());

  if (resource === 'patches') {
    if (!key) {
      if (request.method !== 'POST') return fail(405, 'POST a patch');
      const b = await body();
      const name = validName(b?.name);
      const doc = validDoc(b?.doc);
      if (!name || !doc) return fail(400, 'needs a name and a patch document (under 1.9 MB)');
      return json(await lib.savePatch({ name, doc }), 201);
    }
    if (!PATCH_ID.test(key)) return fail(404, 'no such patch');
    if (request.method === 'GET') {
      const p = await lib.getPatch(key);
      return p ? json(p) : fail(404, 'no such patch');
    }
    if (request.method === 'PUT') {
      const b = await body();
      const name = validName(b?.name);
      if (!name) return fail(400, 'needs a name');
      if (b?.doc === undefined) return (await lib.renamePatch(key, name)) ? json({ id: key, name }) : fail(404, 'no such patch');
      const doc = validDoc(b.doc);
      if (!doc) return fail(400, 'not a patch document (or over 1.9 MB)');
      try {
        return json(await lib.savePatch({ id: key, name, doc }));
      } catch {
        return fail(404, 'no such patch');
      }
    }
    if (request.method === 'DELETE') return (await lib.deletePatch(key)) ? json({ deleted: key }) : fail(404, 'no such patch');
    return fail(405, 'method not allowed');
  }

  if (resource === 'sessions' && key) {
    if (!SESSION.test(key)) return fail(404, 'no such session');
    if (request.method === 'GET') {
      const s = await lib.getSession(key);
      return s ? json(s) : fail(404, 'no such session');
    }
    if (request.method === 'PUT') {
      const b = await body();
      const doc = validDoc(b?.doc);
      if (!doc) return fail(400, 'not a patch document (or over 1.9 MB)');
      const libraryId = typeof b?.libraryId === 'string' && PATCH_ID.test(b.libraryId) ? b.libraryId : null;
      const updated = typeof b?.updated === 'number' && Number.isFinite(b.updated) ? b.updated : Date.now();
      await lib.putSession(key, doc, libraryId, b?.dirty === true, updated);
      return json({ saved: key });
    }
    if (request.method === 'DELETE') return (await lib.deleteSession(key)) ? json({ deleted: key }) : fail(404, 'no such session');
    return fail(405, 'method not allowed');
  }

  return fail(404, 'not found');
}
