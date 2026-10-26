// Each person's patches, in a Durable Object of their own (keyed by their
// Access identity): named saves, and the working patch of every session (a
// session is one conversation with the agent). Sessions autosave here, so a
// reload, a closed tab or a new patch never loses one.

import { DurableObject } from 'cloudflare:workers';

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

/** SQLite values in a Durable Object are capped at 2 MB. */
export const MAX_DOC_CHARS = 1_900_000;

function facts(doc: string): { title: string; modules: number; subpatches: number } {
  try {
    const d = JSON.parse(doc) as { title?: string; modules?: object; subpatches?: object };
    return { title: d.title ?? 'untitled patch', modules: Object.keys(d.modules ?? {}).length, subpatches: Object.keys(d.subpatches ?? {}).length };
  } catch {
    return { title: 'untitled patch', modules: 0, subpatches: 0 };
  }
}

export class PatchLibrary extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS patches (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, doc TEXT NOT NULL,
      modules INTEGER NOT NULL, subpatches INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      name TEXT PRIMARY KEY, title TEXT NOT NULL, doc TEXT NOT NULL,
      modules INTEGER NOT NULL, library_id TEXT, dirty INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL)`);
    const columns = this.sql.exec<{ name: string }>('PRAGMA table_info(sessions)').toArray();
    if (!columns.some((c) => c.name === 'dirty')) this.sql.exec('ALTER TABLE sessions ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0');
  }

  list(): { patches: PatchSummary[]; sessions: SessionSummary[] } {
    const patches = this.sql
      .exec<{ id: string; name: string; created: number; updated: number; modules: number; subpatches: number }>(
        'SELECT id, name, created, updated, modules, subpatches FROM patches ORDER BY updated DESC',
      )
      .toArray();
    const sessions = this.sql
      .exec<{ name: string; title: string; updated: number; modules: number; library_id: string | null }>(
        'SELECT name, title, updated, modules, library_id FROM sessions ORDER BY updated DESC LIMIT 40',
      )
      .toArray()
      .map((r) => ({ name: r.name, title: r.title, updated: r.updated, modules: r.modules, libraryId: r.library_id }));
    return { patches, sessions };
  }

  getPatch(id: string): { id: string; name: string; doc: unknown; updated: number } | null {
    const r = this.sql.exec<{ id: string; name: string; doc: string; updated: number }>('SELECT id, name, doc, updated FROM patches WHERE id = ?', id).toArray()[0];
    return r ? { id: r.id, name: r.name, doc: JSON.parse(r.doc), updated: r.updated } : null;
  }

  /** Create (no id) or update a named patch. */
  savePatch(input: { id?: string; name: string; doc: string }): PatchSummary {
    const now = Date.now();
    const f = facts(input.doc);
    if (input.id) {
      const existing = this.sql.exec<{ created: number }>('SELECT created FROM patches WHERE id = ?', input.id).toArray()[0];
      if (!existing) throw new Error('no such patch');
      this.sql.exec('UPDATE patches SET name = ?, doc = ?, modules = ?, subpatches = ?, updated = ? WHERE id = ?', input.name, input.doc, f.modules, f.subpatches, now, input.id);
      return { id: input.id, name: input.name, created: existing.created, updated: now, modules: f.modules, subpatches: f.subpatches };
    }
    const id = `p-${crypto.randomUUID()}`;
    this.sql.exec('INSERT INTO patches (id, name, doc, modules, subpatches, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)', id, input.name, input.doc, f.modules, f.subpatches, now, now);
    return { id, name: input.name, created: now, updated: now, modules: f.modules, subpatches: f.subpatches };
  }

  renamePatch(id: string, name: string): boolean {
    return this.sql.exec('UPDATE patches SET name = ?, updated = ? WHERE id = ?', name, Date.now(), id).rowsWritten > 0;
  }

  deletePatch(id: string): boolean {
    return this.sql.exec('DELETE FROM patches WHERE id = ?', id).rowsWritten > 0;
  }

  getSession(name: string): { doc: unknown; libraryId: string | null; dirty: boolean; updated: number } | null {
    const r = this.sql
      .exec<{ doc: string; library_id: string | null; dirty: number; updated: number }>('SELECT doc, library_id, dirty, updated FROM sessions WHERE name = ?', name)
      .toArray()[0];
    return r ? { doc: JSON.parse(r.doc), libraryId: r.library_id, dirty: r.dirty === 1, updated: r.updated } : null;
  }

  /**
   * A session's working patch: the saved patch it's linked to, whether it has
   * changed since, and the client's clock — the newest copy wins.
   */
  putSession(name: string, doc: string, libraryId: string | null, dirty: boolean, updated: number): void {
    const f = facts(doc);
    this.sql.exec(
      `INSERT INTO sessions (name, title, doc, modules, library_id, dirty, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET title = excluded.title, doc = excluded.doc, modules = excluded.modules,
         library_id = excluded.library_id, dirty = excluded.dirty, updated = excluded.updated
       WHERE excluded.updated >= sessions.updated`,
      name, f.title, doc, f.modules, libraryId, dirty ? 1 : 0, updated,
    );
  }

  deleteSession(name: string): boolean {
    return this.sql.exec('DELETE FROM sessions WHERE name = ?', name).rowsWritten > 0;
  }
}
