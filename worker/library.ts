// Each person's library, in a Durable Object of their own (keyed by their
// Access identity). It's organised like directories:
//
//   AGENTS.md            yours: every session reads it
//   a set/               AGENTS.md + songs (a set list)
//     a song/            AGENTS.md + sessions
//       a session        one conversation with the agent and the patch it's about
//
// None of it is imposed: a session can stand on its own at the top, a song
// needn't be in a set, and either moves in later. A session can branch from
// another at any message (its conversation up to there, and the patch as it
// was then). The conversation itself lives in the session's PatterAgent;
// here is its place in the tree and its latest patch (autosaved).

import { DurableObject } from 'cloudflare:workers';

/** An audio file in the person's library (the bytes are in R2, by hash). */
export type SampleEntry = {
  hash: string;
  name: string;
  bytes: number;
  mime: string;
  duration: number;
  channels: number;
  created: number;
};

export type SetEntry = { id: string; name: string; agents: string; created: number; updated: number };
export type SongEntry = { id: string; name: string; setId: string | null; agents: string; position: number; created: number; updated: number };
export type ForkKeep = 'before' | 'after' | 'all' | 'none';
export type SessionEntry = {
  name: string;
  title: string;
  songId: string | null;
  /** The session it branched from, at which message, keeping what, and how many messages it took. */
  parent: string | null;
  forkAt: string | null;
  forkKeep: ForkKeep | null;
  prefix: number;
  modules: number;
  /** Messages the person has sent in it. */
  turns: number;
  created: number;
  updated: number;
};
export type LibraryTree = { agents: string; sets: SetEntry[]; songs: SongEntry[]; sessions: SessionEntry[] };

/** The context a session works in: yours, its set's, its song's. */
export type SessionContext = {
  agents: string;
  set: { id: string; name: string; agents: string } | null;
  song: { id: string; name: string; agents: string } | null;
};

/** SQLite values in a Durable Object are capped at 2 MB. */
export const MAX_DOC_CHARS = 1_900_000;
export const MAX_AGENTS_CHARS = 60_000;

function facts(doc: string): { title: string; modules: number } {
  try {
    const d = JSON.parse(doc) as { title?: string; modules?: object };
    return { title: d.title ?? 'untitled patch', modules: Object.keys(d.modules ?? {}).length };
  } catch {
    return { title: 'untitled patch', modules: 0 };
  }
}

type SessionRow = {
  name: string; title: string; song_id: string | null; parent: string | null; fork_at: string | null; fork_keep: string | null;
  prefix: number | null; modules: number; turns: number | null; created: number | null; updated: number;
};
const toSession = (r: SessionRow): SessionEntry => ({
  name: r.name, title: r.title, songId: r.song_id, parent: r.parent, forkAt: r.fork_at, forkKeep: (r.fork_keep as ForkKeep | null) ?? null,
  prefix: r.prefix ?? 0, modules: r.modules, turns: r.turns ?? 0, created: r.created ?? r.updated, updated: r.updated,
});
const SESSION_COLUMNS = 'name, title, song_id, parent, fork_at, fork_keep, prefix, modules, turns, created, updated';

export class PatchLibrary extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      name TEXT PRIMARY KEY, title TEXT NOT NULL, doc TEXT NOT NULL,
      modules INTEGER NOT NULL, library_id TEXT, dirty INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS samples (
      hash TEXT PRIMARY KEY, name TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT NOT NULL,
      duration REAL NOT NULL, channels INTEGER NOT NULL, created INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, agents TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, set_id TEXT, agents TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Deleted sessions, so a late autosave (a closing tab's) can't bring one back.
    this.sql.exec('CREATE TABLE IF NOT EXISTS deleted_sessions (name TEXT PRIMARY KEY, deleted INTEGER NOT NULL)');
    const has = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(sessions)').toArray().map((c) => c.name));
    const add = (col: string, type: string) => !has.has(col) && this.sql.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`);
    add('dirty', 'INTEGER NOT NULL DEFAULT 0');
    add('song_id', 'TEXT');
    add('parent', 'TEXT');
    add('fork_at', 'TEXT');
    add('fork_keep', 'TEXT');
    add('prefix', 'INTEGER');
    if (!has.has('turns')) {
      add('turns', 'INTEGER');
      // Sessions from before this was counted: any with a patch or a name has been used.
      this.sql.exec("UPDATE sessions SET turns = CASE WHEN modules > 0 OR title != 'untitled patch' THEN 1 ELSE 0 END WHERE turns IS NULL");
    }
    add('created', 'INTEGER');
    this.migrateSavedPatches();
  }

  /**
   * Before sets and songs there were named saves ("saved patches"). Each
   * becomes a session of its own at the top level, so nothing saved is lost.
   */
  private migrateSavedPatches() {
    if (this.sql.exec("SELECT 1 FROM meta WHERE key = 'migrated_patches'").toArray().length) return;
    const table = this.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'patches'").toArray();
    if (table.length) {
      const saved = this.sql.exec<{ name: string; doc: string; created: number; updated: number }>('SELECT name, doc, created, updated FROM patches').toArray();
      for (const p of saved) {
        let doc = p.doc;
        try {
          doc = JSON.stringify({ ...(JSON.parse(p.doc) as object), title: p.name });
        } catch {
          /* keep it as it was */
        }
        const f = facts(doc);
        this.sql.exec(
          `INSERT OR IGNORE INTO sessions (name, title, doc, modules, updated, created, turns, prefix) VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
          `s-${crypto.randomUUID()}`, f.title, doc, f.modules, p.updated, p.created,
        );
      }
    }
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_patches', ?)", String(Date.now()));
  }

  // ── the tree ──────────────────────────────────────────────────────────────

  tree(): LibraryTree {
    const sets = this.sql.exec<SetEntry>('SELECT id, name, agents, created, updated FROM sets ORDER BY created').toArray();
    const songs = this.sql
      .exec<{ id: string; name: string; set_id: string | null; agents: string; position: number; created: number; updated: number }>(
        'SELECT id, name, set_id, agents, position, created, updated FROM songs ORDER BY position, created',
      )
      .toArray()
      .map((r) => ({ id: r.id, name: r.name, setId: r.set_id, agents: r.agents, position: r.position, created: r.created, updated: r.updated }));
    const sessions = this.sql.exec<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated DESC LIMIT 2000`).toArray().map(toSession);
    return { agents: this.userAgents(), sets, songs, sessions };
  }

  private userAgents(): string {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'agents'").toArray()[0]?.value ?? '';
  }

  setUserAgents(text: string): void {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('agents', ?)", text);
  }

  contextFor(session: string): SessionContext {
    const s = this.sql.exec<{ song_id: string | null }>('SELECT song_id FROM sessions WHERE name = ?', session).toArray()[0];
    const song = s?.song_id
      ? this.sql.exec<{ id: string; name: string; agents: string; set_id: string | null }>('SELECT id, name, agents, set_id FROM songs WHERE id = ?', s.song_id).toArray()[0]
      : undefined;
    const set = song?.set_id ? this.sql.exec<{ id: string; name: string; agents: string }>('SELECT id, name, agents FROM sets WHERE id = ?', song.set_id).toArray()[0] : undefined;
    return {
      agents: this.userAgents(),
      set: set ? { id: set.id, name: set.name, agents: set.agents } : null,
      song: song ? { id: song.id, name: song.name, agents: song.agents } : null,
    };
  }

  // ── sets ──────────────────────────────────────────────────────────────────

  createSet(name: string): SetEntry {
    const now = Date.now();
    const id = `set-${crypto.randomUUID()}`;
    this.sql.exec('INSERT INTO sets (id, name, agents, created, updated) VALUES (?, ?, ?, ?, ?)', id, name, '', now, now);
    return { id, name, agents: '', created: now, updated: now };
  }

  updateSet(id: string, patch: { name?: string; agents?: string }): boolean {
    const now = Date.now();
    let n = 0;
    if (patch.name !== undefined) n += this.sql.exec('UPDATE sets SET name = ?, updated = ? WHERE id = ?', patch.name, now, id).rowsWritten;
    if (patch.agents !== undefined) n += this.sql.exec('UPDATE sets SET agents = ?, updated = ? WHERE id = ?', patch.agents, now, id).rowsWritten;
    return n > 0 || this.sql.exec('SELECT 1 FROM sets WHERE id = ?', id).toArray().length > 0;
  }

  /** Delete a set. Its songs move to the top level, or (cascade) go too; returns the sessions that went. */
  deleteSet(id: string, cascade: boolean): { deleted: boolean; sessions: string[] } {
    const songs = this.sql.exec<{ id: string }>('SELECT id FROM songs WHERE set_id = ?', id).toArray().map((r) => r.id);
    const sessions: string[] = [];
    for (const song of songs) {
      if (cascade) sessions.push(...this.deleteSong(song, true).sessions);
      else this.sql.exec('UPDATE songs SET set_id = NULL, updated = ? WHERE id = ?', Date.now(), song);
    }
    const deleted = this.sql.exec('DELETE FROM sets WHERE id = ?', id).rowsWritten > 0;
    return { deleted, sessions };
  }

  // ── songs ─────────────────────────────────────────────────────────────────

  createSong(name: string, setId: string | null): SongEntry {
    if (setId && !this.sql.exec('SELECT 1 FROM sets WHERE id = ?', setId).toArray().length) throw new Error('no such set');
    const now = Date.now();
    const id = `song-${crypto.randomUUID()}`;
    const position = (this.sql.exec<{ p: number | null }>('SELECT MAX(position) AS p FROM songs WHERE set_id IS ?', setId).toArray()[0]?.p ?? -1) + 1;
    this.sql.exec('INSERT INTO songs (id, name, set_id, agents, position, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name, setId, '', position, now, now);
    return { id, name, setId, agents: '', position, created: now, updated: now };
  }

  /** Rename, rewrite its AGENTS.md, move it into a set (or out: null), or put it at a place in its set. */
  updateSong(id: string, patch: { name?: string; agents?: string; setId?: string | null; position?: number }): boolean {
    if (!this.sql.exec('SELECT 1 FROM songs WHERE id = ?', id).toArray().length) return false;
    if (patch.setId && !this.sql.exec('SELECT 1 FROM sets WHERE id = ?', patch.setId).toArray().length) throw new Error('no such set');
    const now = Date.now();
    if (patch.name !== undefined) this.sql.exec('UPDATE songs SET name = ?, updated = ? WHERE id = ?', patch.name, now, id);
    if (patch.agents !== undefined) this.sql.exec('UPDATE songs SET agents = ?, updated = ? WHERE id = ?', patch.agents, now, id);
    if (patch.setId !== undefined) {
      const position = (this.sql.exec<{ p: number | null }>('SELECT MAX(position) AS p FROM songs WHERE set_id IS ?', patch.setId).toArray()[0]?.p ?? -1) + 1;
      this.sql.exec('UPDATE songs SET set_id = ?, position = ?, updated = ? WHERE id = ?', patch.setId, position, now, id);
    }
    if (patch.position !== undefined) {
      // Re-number the songs beside it, with this one at `position`.
      const setId = this.sql.exec<{ set_id: string | null }>('SELECT set_id FROM songs WHERE id = ?', id).one().set_id;
      const order = this.sql.exec<{ id: string }>('SELECT id FROM songs WHERE set_id IS ? AND id != ? ORDER BY position, created', setId, id).toArray().map((r) => r.id);
      order.splice(Math.max(0, Math.min(order.length, Math.round(patch.position))), 0, id);
      order.forEach((sid, i) => this.sql.exec('UPDATE songs SET position = ? WHERE id = ?', i, sid));
    }
    return true;
  }

  /** Delete a song. Its sessions move to the top level, or (cascade) go too; returns the sessions that went. */
  deleteSong(id: string, cascade: boolean): { deleted: boolean; sessions: string[] } {
    const sessions = this.sql.exec<{ name: string }>('SELECT name FROM sessions WHERE song_id = ?', id).toArray().map((r) => r.name);
    if (cascade) for (const s of sessions) this.deleteSession(s);
    else this.sql.exec('UPDATE sessions SET song_id = NULL WHERE song_id = ?', id);
    const deleted = this.sql.exec('DELETE FROM songs WHERE id = ?', id).rowsWritten > 0;
    return { deleted, sessions: cascade ? sessions : [] };
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  /** A session's place and its latest patch (as JSON text). */
  getSession(name: string): (SessionEntry & { doc: string }) | null {
    const r = this.sql.exec<SessionRow & { doc: string }>(`SELECT ${SESSION_COLUMNS}, doc FROM sessions WHERE name = ?`, name).toArray()[0];
    return r ? { ...toSession(r), doc: r.doc } : null;
  }

  hasSession(name: string): boolean {
    return this.sql.exec('SELECT 1 FROM sessions WHERE name = ?', name).toArray().length > 0;
  }

  /** A new session: empty, a fresh start from a patch, or a branch of another. */
  createSession(input: { name: string; doc: string; songId: string | null; parent?: string; forkAt?: string | null; forkKeep?: ForkKeep; prefix?: number; turns?: number }): SessionEntry {
    if (input.songId && !this.sql.exec('SELECT 1 FROM songs WHERE id = ?', input.songId).toArray().length) throw new Error('no such song');
    const now = Date.now();
    const f = facts(input.doc);
    this.sql.exec(
      `INSERT INTO sessions (name, title, doc, modules, song_id, parent, fork_at, fork_keep, prefix, turns, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name, f.title, input.doc, f.modules, input.songId, input.parent ?? null, input.forkAt ?? null, input.forkKeep ?? null,
      input.prefix ?? 0, input.turns ?? 0, now, now,
    );
    return this.getSessionEntry(input.name)!;
  }

  private getSessionEntry(name: string): SessionEntry | null {
    const r = this.sql.exec<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE name = ?`, name).toArray()[0];
    return r ? toSession(r) : null;
  }

  /**
   * A session's working patch (autosave), with the client's clock: the newest
   * copy wins. A session nobody created yet (the very first one) starts at the top.
   */
  putSession(name: string, doc: string, updated: number, turns: number | null): void {
    if (this.sql.exec('SELECT 1 FROM deleted_sessions WHERE name = ?', name).toArray().length) return;
    const f = facts(doc);
    this.sql.exec(
      `INSERT INTO sessions (name, title, doc, modules, turns, prefix, created, updated) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(name) DO UPDATE SET title = excluded.title, doc = excluded.doc, modules = excluded.modules,
         turns = COALESCE(?, sessions.turns), updated = excluded.updated
       WHERE excluded.updated >= sessions.updated`,
      name, f.title, doc, f.modules, turns ?? 0, Date.now(), updated, turns,
    );
  }

  /** Rename a session: its patch takes the title. */
  renameSession(name: string, title: string): boolean {
    const r = this.sql.exec<{ doc: string }>('SELECT doc FROM sessions WHERE name = ?', name).toArray()[0];
    if (!r) return false;
    let doc = r.doc;
    try {
      doc = JSON.stringify({ ...(JSON.parse(r.doc) as object), title });
    } catch {
      /* leave the doc */
    }
    this.sql.exec('UPDATE sessions SET title = ?, doc = ?, updated = ? WHERE name = ?', title, doc, Date.now(), name);
    return true;
  }

  /** Move a session into a song, or to the top level (null). */
  moveSession(name: string, songId: string | null): boolean {
    if (songId && !this.sql.exec('SELECT 1 FROM songs WHERE id = ?', songId).toArray().length) throw new Error('no such song');
    return this.sql.exec('UPDATE sessions SET song_id = ? WHERE name = ?', songId, name).rowsWritten > 0;
  }

  deleteSession(name: string): boolean {
    this.sql.exec('INSERT OR REPLACE INTO deleted_sessions (name, deleted) VALUES (?, ?)', name, Date.now());
    return this.sql.exec('DELETE FROM sessions WHERE name = ?', name).rowsWritten > 0;
  }

  // ── samples ───────────────────────────────────────────────────────────────

  listSamples(): SampleEntry[] {
    return this.sql.exec<SampleEntry>('SELECT hash, name, bytes, mime, duration, channels, created FROM samples ORDER BY created DESC').toArray();
  }

  hasSample(hash: string): boolean {
    return this.sql.exec('SELECT 1 FROM samples WHERE hash = ?', hash).toArray().length > 0;
  }

  /** Add a sample to the catalog (or rename it, if the same audio comes in again). */
  putSample(entry: Omit<SampleEntry, 'created'>): SampleEntry {
    const created = Date.now();
    this.sql.exec(
      `INSERT INTO samples (hash, name, bytes, mime, duration, channels, created) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET name = excluded.name`,
      entry.hash, entry.name, entry.bytes, entry.mime, entry.duration, entry.channels, created,
    );
    return this.sql.exec<SampleEntry>('SELECT hash, name, bytes, mime, duration, channels, created FROM samples WHERE hash = ?', entry.hash).one();
  }

  deleteSample(hash: string): boolean {
    return this.sql.exec('DELETE FROM samples WHERE hash = ?', hash).rowsWritten > 0;
  }
}
