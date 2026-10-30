// The library on the server (a Durable Object per person, behind Access):
// your AGENTS.md, sets, songs and sessions — each session's latest patch and
// its place in the tree — and the samples. A session's conversation and its
// checkpoints live with its agent; branching copies them.

import type { PatchDoc } from '../runtime/patch';

export interface SetEntry {
  id: string;
  name: string;
  agents: string;
  created: number;
  updated: number;
}

export interface SongEntry {
  id: string;
  name: string;
  setId: string | null;
  agents: string;
  position: number;
  created: number;
  updated: number;
}

export type ForkKeep = 'before' | 'after' | 'all' | 'none';

export interface SessionEntry {
  name: string;
  title: string;
  songId: string | null;
  /** The session it branched from, at which message, keeping what; `prefix` messages came with it. */
  parent: string | null;
  forkAt: string | null;
  forkKeep: ForkKeep | null;
  prefix: number;
  modules: number;
  turns: number;
  created: number;
  updated: number;
}

export interface LibraryTree {
  agents: string;
  sets: SetEntry[];
  songs: SongEntry[];
  sessions: SessionEntry[];
}

/** A session's working patch, as the server (or this browser) keeps it. */
export interface SessionSnapshot {
  doc: PatchDoc;
  /** Client clock when it was written; the newest copy wins. */
  updated: number;
}

export type CheckpointKind = 'before' | 'after' | 'manual';
export interface CheckpointMeta {
  id: string;
  /** The message it belongs to (a manual one: the last message when it was made). */
  at: string | null;
  kind: CheckpointKind;
  label: string | null;
  modules: number;
  created: number;
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
      if (res.status === 403 || res.redirected) msg = 'not signed in: sign in again at /login';
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const need = <T>(v: T | null, what: string): T => {
  if (v === null) throw new Error(`${what} is gone`);
  return v;
};

/** An audio file in the person's library. */
export interface LibrarySample {
  hash: string;
  name: string;
  bytes: number;
  mime: string;
  duration: number;
  channels: number;
  created: number;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

export const library = {
  async tree(): Promise<LibraryTree> {
    return need(await call<LibraryTree>('GET', 'library'), 'the library');
  },
  setUserAgents: (agents: string) => call('PUT', 'context', { agents }),

  createSet: async (name: string) => need(await call<SetEntry>('POST', 'sets', { name }), 'the library'),
  updateSet: (id: string, patch: { name?: string; agents?: string }) => call('PUT', `sets/${id}`, patch),
  removeSet: (id: string, cascade: boolean) => call<{ sessions: string[] }>('DELETE', `sets/${id}${cascade ? '?cascade=1' : ''}`),

  createSong: async (name: string, setId: string | null) => need(await call<SongEntry>('POST', 'songs', { name, setId }), 'the library'),
  updateSong: (id: string, patch: { name?: string; agents?: string; setId?: string | null; position?: number }) => call('PUT', `songs/${id}`, patch),
  removeSong: (id: string, cascade: boolean) => call<{ sessions: string[] }>('DELETE', `songs/${id}${cascade ? '?cascade=1' : ''}`),

  createSession: async (name: string, doc: PatchDoc, songId: string | null) => need(await call<SessionEntry>('POST', 'sessions', { name, doc, songId }), 'the library'),
  session: (name: string) => call<SessionEntry & { doc: PatchDoc }>('GET', `sessions/${name}`),
  putSession: (name: string, snap: SessionSnapshot & { turns?: number }) => call<{ saved: string }>('PUT', `sessions/${name}`, snap),
  updateSession: (name: string, patch: { title?: string; songId?: string | null }) => call('PATCH', `sessions/${name}`, patch),
  removeSession: (name: string) => call<{ deleted: string }>('DELETE', `sessions/${name}`),
  async fork(from: string, opts: { keep: ForkKeep; at?: string | null; checkpoint?: string; title?: string; songId?: string | null; doc?: PatchDoc }): Promise<{ session: SessionEntry & { doc: PatchDoc }; approximate: boolean }> {
    return need(await call('POST', `sessions/${from}/fork`, opts), 'that session');
  },
  async checkpoints(name: string): Promise<CheckpointMeta[]> {
    return (await call<CheckpointMeta[]>('GET', `sessions/${name}/checkpoints`)) ?? [];
  },
  checkpoint: (name: string, id: string) => call<CheckpointMeta & { doc: PatchDoc }>('GET', `sessions/${name}/checkpoints/${id}`),
  putCheckpoint: (name: string, cp: { at: string | null; kind: 'after' | 'manual'; label?: string | null; doc: PatchDoc }) =>
    call<CheckpointMeta>('POST', `sessions/${name}/checkpoints`, cp),

  async samples(): Promise<LibrarySample[]> {
    return (await call<LibrarySample[]>('GET', 'samples')) ?? [];
  },
  /** Upload an audio file (it's stored by its SHA-256, so the same file twice is stored once). */
  async uploadSample(bytes: ArrayBuffer, hash: string, meta: { name: string; type: string; duration?: number; channels?: number }): Promise<LibrarySample> {
    const q = new URLSearchParams({ name: meta.name, duration: String(meta.duration ?? 0), channels: String(meta.channels ?? 0) });
    const res = await fetch(`/api/samples/${hash}?${q}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'x-patter': '1', 'x-sample-type': meta.type || 'application/octet-stream' },
      body: bytes,
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* not JSON */
      }
      throw new Error(`upload failed: ${msg}`);
    }
    return (await res.json()) as LibrarySample;
  },
  removeSample: (hash: string) => call<{ deleted: string }>('DELETE', `samples/${hash}`),
};

/** Sonic Pi's pack, as public/samples/index.json lists it. */
export interface StockSample {
  name: string;
  category: string;
  bytes: number;
}

let stockIndex: Promise<StockSample[]> | null = null;
export function stockSamples(): Promise<StockSample[]> {
  stockIndex ??= fetch('/samples/index.json').then((r) => (r.ok ? (r.json() as Promise<StockSample[]>) : []));
  return stockIndex;
}
