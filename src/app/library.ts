// The patch library on the server (a Durable Object per person, behind
// Access): named saves, and each session's working patch.

import type { PatchDoc } from '../runtime/patch';

export interface PatchSummary {
  id: string;
  name: string;
  created: number;
  updated: number;
  modules: number;
  subpatches: number;
}

export interface SessionSummary {
  name: string;
  title: string;
  updated: number;
  modules: number;
  libraryId: string | null;
}

/** A session's working patch, as the server (or this browser) keeps it. */
export interface SessionSnapshot {
  doc: PatchDoc;
  libraryId: string | null;
  /** Changed since it was last saved to (or opened from) the library. */
  dirty: boolean;
  /** Client clock when it was written; the newest copy wins. */
  updated: number;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const res = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { 'x-patter': '1' } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not JSON (an Access login page, say) */
      if (res.status === 403 || res.redirected) msg = 'not signed in (reload the page to sign in again)';
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const need = <T>(v: T | null, what: string): T => {
  if (v === null) throw new Error(`${what} is gone`);
  return v;
};

export const library = {
  async list(): Promise<{ patches: PatchSummary[]; sessions: SessionSummary[] }> {
    return (await call('GET', 'library')) ?? { patches: [], sessions: [] };
  },
  get: (id: string) => call<{ id: string; name: string; doc: PatchDoc; updated: number }>('GET', `patches/${id}`),
  async create(name: string, doc: PatchDoc): Promise<PatchSummary> {
    return need(await call<PatchSummary>('POST', 'patches', { name, doc }), 'the library');
  },
  /** Update a saved patch; null when it no longer exists. */
  update: (id: string, name: string, doc: PatchDoc) => call<PatchSummary>('PUT', `patches/${id}`, { name, doc }),
  rename: (id: string, name: string) => call<{ id: string; name: string }>('PUT', `patches/${id}`, { name }),
  remove: (id: string) => call<{ deleted: string }>('DELETE', `patches/${id}`),
  session: (name: string) => call<SessionSnapshot>('GET', `sessions/${name}`),
  putSession: (name: string, snap: SessionSnapshot) => call<{ saved: string }>('PUT', `sessions/${name}`, snap),
  removeSession: (name: string) => call<{ deleted: string }>('DELETE', `sessions/${name}`),
};
