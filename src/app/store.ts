// The app: one engine, one runtime, one sequencer (the agent lives in a
// Cloudflare Durable Object; see worker/) — the session they belong to, the
// library it lives in, the transport, and the small bits of UI state React
// subscribes to.
//
// A session is one conversation with the agent and the patch it's about. Its
// patch autosaves (to this browser and to the library on the server), and
// comes back when the page does: audio starts on a click, then the patch
// loads, then any tool calls the agent left waiting run against it.
//
// Sessions live in songs, songs in sets (or not: anything can stand at the
// top and be filed later), each level with an AGENTS.md the agent reads. A
// session can branch from any message of another: the conversation up to
// there and the patch as it was then (every message and every turn keeps a
// checkpoint), so trying something never costs what you had.
//
// The page is the host's or a listener's (role.ts). A listener's page plays
// what's on air (radio.ts), its knobs its own, and reaches neither the agent
// nor the library.

import { useSyncExternalStore } from 'react';
import { Engine, type EngineLogEntry } from '../engine/engine';
import { floatWav, SampleBank } from '../engine/samples';
import { GROUPS } from '../engine/groups';
import { Runtime } from '../runtime/runtime';
import { Sequencer } from '../seq/sequencer';
import { emptyPatch, leafOf, migratePatch, parentOf, type PatchDoc } from '../runtime/patch';
import { library, sha256, type CheckpointMeta, type ForkKeep, type LibraryTree, type SessionEntry, type SessionSnapshot } from './library';
import { broadcastSample, Radio } from './radio';
import { formatTime, Recorder } from './recorder';
import type { Role } from './role';
import { takeFileName, type Take } from './takes';
import { contextOf, setOf, songOf, titleFrom, UNTITLED } from './tree';

type Listener = () => void;

class Emitter {
  private ls = new Set<Listener>();
  version = 0;
  on = (fn: Listener) => {
    this.ls.add(fn);
    return () => {
      this.ls.delete(fn);
    };
  };
  emit = () => {
    this.version++;
    for (const fn of this.ls) fn();
  };
}

const SESSION_KEY = 'patter.session.v1';
const SETTINGS_KEY = 'patter.settings.v1';
const NAV_KEY = 'patter.nav.v1';
/** The single autosave from before sessions kept their own patches. */
const LEGACY_PATCH_KEY = 'patter.patch.v1';
const LEGACY_DONE_KEY = 'patter.patch.v1.migrated';
const localPatchKey = (session: string) => `patter.session-patch.${session}`;
const abandonedKey = (session: string) => `patter.abandoned.${session}`;

export type Effort = 'off' | 'low' | 'high';

export interface Settings {
  /** DeepSeek V4.1 Flash reasoning effort. */
  effort: Effort;
  autoSendVoice: boolean;
  /** How much of the mix ⟲ capture keeps (it's held in memory). */
  captureMinutes: number;
  /** Download each take as soon as it's done. */
  autoDownload: boolean;
}

export type Panel = 'performance' | 'selected' | 'mixer' | 'samples' | 'recordings';

export interface Toast {
  id: number;
  text: string;
  /** A take it's about (offers its download). */
  take?: string;
  error?: boolean;
}

/** Something in the library: a session, a song or a set. */
export type Entry = { type: 'session' | 'song' | 'set'; id: string };

export type Dialog =
  | { kind: 'rename'; entry: Entry }
  | { kind: 'create'; type: 'song' | 'set'; setId?: string | null; fileSession?: string }
  | { kind: 'context'; level: 'person' | 'song' | 'set'; id?: string }
  | { kind: 'delete'; entry: Entry }
  | { kind: 'checkpoint' }
  | { kind: 'clear-patch' };

function loadFlag(key: string, dflt: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === '1';
  } catch {
    return dflt;
  }
}

function loadSettings(): Settings {
  const dflt: Settings = { effort: 'low', autoSendVoice: true, captureMinutes: 5, autoDownload: false };
  try {
    return { ...dflt, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return dflt;
  }
}

const freshSessionName = () => `s-${crypto.randomUUID()}`;

function loadSessionName(): string {
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const fresh = freshSessionName();
    localStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    return 's-ephemeral';
  }
}

const hasContent = (doc: PatchDoc | undefined) => Boolean(doc && (Object.keys(doc.modules ?? {}).length || Object.keys(doc.routines ?? {}).length));

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export class App {
  readonly engine = new Engine();
  readonly bank = new SampleBank(this.engine);
  readonly runtime = new Runtime(this.engine, this.bank);
  readonly seq = new Sequencer(this.runtime, this.engine);
  /** Recording the mix (● REC) and capturing its last minutes (⟲). */
  readonly recorder = new Recorder(this.engine, {
    changed: () => this.uiEvents.emit(),
    patchTitle: () => this.runtime.doc.title,
    finished: (take) => this.tookTake(take),
    problem: (text) => this.showToast(text, { error: true }),
  });

  readonly patchEvents = new Emitter();
  readonly uiEvents = new Emitter();
  readonly logEvents = new Emitter();

  /**
   * Whose page this is: the host's (signed in through Access: the agent, the
   * library) or a listener's (what's on air, played here; nothing goes
   * back). Settled before anything loads (begin).
   */
  role: Role = 'listener';
  /** A listener's page: the broadcast it's tuned to. */
  readonly radio = new Radio({
    play: (doc) => this.tuneIn(doc),
    transport: (stopped) => (stopped ? this.stop() : this.play()),
    changed: () => this.uiEvents.emit(),
  });

  /** off → (click) booting → restoring (the session's patch, or what's on air) → ready. */
  state: 'off' | 'booting' | 'restoring' | 'ready' | 'error' = 'off';
  bootError = '';
  /** The subpatch the graph shows ('' = the top level). */
  scope = '';
  /** Selected graph nodes: module and subpatch paths, 'macro:<path>'. */
  selection: string[] = [];
  /** What the knob area shows: the scope's Performance Panel, the selection, the mixer, the samples or the takes. */
  panel: Panel = 'performance';
  /** A note at the top of the page (a take is done, say). */
  toast: Toast | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Files being read, uploaded and loaded (for the Samples tab). */
  incoming: string[] = [];
  /** A recording in progress. */
  recording: { source: string; bars: number; started: number } | null = null;
  /** The open patch dialog, if any. */
  dialog: Dialog | null = null;
  settings: Settings = loadSettings();

  // ── the session ──
  /** The conversation (the agent Durable Object's name) and the patch that goes with it. */
  session = loadSessionName();
  /** What this session will bring back, known before audio starts (for the start screen). */
  resumes: { title: string; modules: number } | null = null;
  /** Bumped by every change to the patch. */
  revision = 0;
  /** The library: your AGENTS.md, sets, songs, sessions. */
  tree: LibraryTree = { agents: '', sets: [], songs: [], sessions: [] };
  treeError: string | null = null;
  /** The session's checkpoints (the patch at each message, each turn's end, and each one you made). */
  checkpoints: CheckpointMeta[] = [];
  /** Messages the person has sent in this session (the chat keeps it current). */
  turns = 0;
  /** The last message in the chat (a manual checkpoint goes after it). */
  lastMessageId: string | null = null;
  /** A message to send once the session's chat has its conversation (an edit or a retry, in a new branch). */
  pendingSend: { session: string; text: string; prefix: number } | null = null;
  /** The navigator (the library, on the left) is open. */
  navOpen = loadFlag(NAV_KEY, true);
  /** The last autosave to the server. */
  autosave: 'idle' | 'saving' | 'saved' | 'offline' = 'idle';
  private snapshot: Promise<SessionSnapshot | null> = Promise.resolve(null);
  /** Nothing autosaves until the session's own patch is back (an empty page mustn't overwrite it). */
  private restored = false;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  // ── the transport ──
  /** The sound is stopped (⌘.): routines paused, the node tree frozen. */
  stopped = false;
  private pausedRoutines: string[] = [];

  // ── the agent ──
  /** Bumped when the agent's turn is stopped; tool calls from before that never run. */
  agentGeneration = 0;
  /** Tool calls that arrived before audio started and are waiting for it. */
  waitingTools = 0;
  /** Tool calls that will never run (their turn was stopped); kept across reloads. */
  abandoned: Set<string>;
  /** What the user did by hand lately, told to the agent with each message. */
  private actions: { at: number; what: string }[] = [];
  private readyWaiters: (() => void)[] = [];
  /** Set by the chat panel: stop the stream. */
  chatStop: () => void = () => {};
  /** Set by the navigator: put the cursor in its search box. */
  focusLibrarySearch: () => void = () => {};

  constructor() {
    this.runtime.onChange(() => {
      this.keepFocusValid();
      this.touched();
      this.patchEvents.emit();
    });
    this.seq.onChange(() => {
      this.touched();
      this.patchEvents.emit();
    });
    this.seq.onLog((text) => {
      this.engine.info(text);
    });
    this.engine.onLog(() => this.logEvents.emit());
    this.abandoned = this.loadAbandoned();
  }

  /**
   * Whose page it is, settled before anything loads. The host's picks up its
   * session and its library; a listener's tunes in, and fetches library
   * samples through the broadcast.
   */
  begin(role: Role) {
    this.role = role;
    if (role === 'listener') {
      this.bank.fetchLibrary = broadcastSample;
      this.radio.connect();
      return;
    }
    this.snapshot = this.fetchSnapshot(this.session, true);
    this.noteResumes();
    void this.refreshTree();
    window.addEventListener('pagehide', () => this.saveNow(true));
  }

  /** A listener's page: what's on air plays here, and nothing goes back. */
  get listening(): boolean {
    return this.role === 'listener';
  }

  // ── starting ─────────────────────────────────────────────────────────────

  /** Start audio (browsers need a click for that), then bring back this session's patch (or what's on air). */
  async start(): Promise<void> {
    if (this.state === 'booting' || this.state === 'restoring' || this.state === 'ready') return;
    this.state = 'booting';
    this.uiEvents.emit();
    try {
      await this.engine.boot();
      this.seq.setBpm(this.runtime.doc.bpm);
      this.seq.start();
      await this.recorder.start(this.settings.captureMinutes).catch((e) => this.engine.info((e as Error).message));
    } catch (e) {
      this.state = 'error';
      this.bootError = String((e as Error)?.message ?? e);
      this.uiEvents.emit();
      return;
    }
    if (this.listening) {
      this.state = 'restoring';
      this.uiEvents.emit();
      await this.radio.start();
    } else if (!this.restored) {
      this.state = 'restoring';
      this.uiEvents.emit();
      const snap = await this.snapshot;
      await this.adopt(snap);
      if (snap?.updated === 0) this.markLegacyDone();
    }
    this.state = 'ready';
    // A brand-new session is in the library from here on (it can be filed, branched, checkpointed).
    if (!this.listening && !this.entry) this.saveNow(false);
    // A listener hears what the host hears: the sound starts stopped if the host stopped it.
    if (this.listening && this.radio.following && this.radio.status?.stopped) this.stop();
    this.uiEvents.emit();
    for (const w of this.readyWaiters.splice(0)) w();
  }

  /** A listener's page takes the host's patch, changing only what differs (the first one: all of it). */
  private async tuneIn(doc: PatchDoc): Promise<void> {
    const next = migratePatch(doc);
    const errors = await this.runtime.reconcile(next);
    try {
      // A new tempo re-anchors the beat: only when it really changed.
      if (next.bpm && next.bpm !== this.runtime.doc.bpm) this.seq.setBpm(next.bpm);
    } catch (e) {
      errors.push((e as Error).message);
    }
    errors.push(...this.seq.follow(next.routines ?? {}));
    this.runtime.resetHistory();
    if (errors.length) this.engine.info(`the patch on air came in with problems: ${errors.join('; ')}`);
  }

  /** Resolves once audio runs and the session's patch is back — or the agent's turn was stopped. */
  whenReady(): Promise<void> {
    return this.state === 'ready' ? Promise.resolve() : new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  /** What the start screen says this session will bring back. */
  private noteResumes() {
    const session = this.session;
    void this.snapshot.then((snap) => {
      if (session !== this.session) return;
      this.resumes = snap && hasContent(snap.doc) ? { title: snap.doc.title, modules: Object.keys(snap.doc.modules).length } : null;
      this.uiEvents.emit();
    });
  }

  /** Load a session snapshot into the (empty) running system and make it this session's patch. */
  private async adopt(snap: SessionSnapshot | null) {
    this.restored = false;
    if (snap && hasContent(snap.doc)) await this.restore(snap.doc);
    else if (snap) {
      this.runtime.setTitle(snap.doc.title);
      this.seq.setBpm(snap.doc.bpm || 110);
      this.runtime.setMasterLevel(snap.doc.master?.level ?? 0.8);
    }
    this.runtime.resetHistory();
    this.restored = true;
    void this.loadCheckpoints();
  }

  async restore(doc: PatchDoc): Promise<string[]> {
    const errors = await this.runtime.loadPatch(doc);
    this.seq.setBpm(doc.bpm || 110);
    errors.push(...this.seq.load(doc.routines ?? {}));
    if (errors.length) this.engine.info(`restored with problems: ${errors.join('; ')}`);
    return errors;
  }

  // ── autosave ─────────────────────────────────────────────────────────────

  private touched() {
    this.revision++;
    if (!this.restored || this.listening) return;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.saveNow(false), 1000);
  }

  /** Write the session's patch: to this browser now, to the server as well. */
  private saveNow(unloading: boolean) {
    if (!this.restored || this.listening) return;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    const snap: SessionSnapshot & { turns: number } = { doc: this.runtime.doc, updated: Date.now(), turns: this.turns };
    const body = JSON.stringify(snap);
    try {
      localStorage.setItem(localPatchKey(this.session), body);
    } catch {
      /* storage full or blocked: the server copy still goes */
    }
    if (unloading) {
      // keepalive requests are capped at 64 KB; bigger patches rely on the copy above.
      if (body.length < 60_000) {
        void fetch(`/api/sessions/${this.session}`, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body }).catch(() => {});
      }
      return;
    }
    this.autosave = 'saving';
    const session = this.session;
    library.putSession(session, snap).then(
      () => {
        this.autosave = 'saved';
        this.listed(session, snap);
        this.uiEvents.emit();
      },
      (e) => {
        this.autosave = 'offline';
        this.engine.info(`couldn't autosave to the library (kept in this browser): ${(e as Error).message}`);
        this.uiEvents.emit();
      },
    );
  }

  /** The newest copy of a session's patch: this browser's or the server's. */
  private async fetchSnapshot(session: string, allowLegacy = false): Promise<SessionSnapshot | null> {
    let local: SessionSnapshot | null = null;
    try {
      const raw = localStorage.getItem(localPatchKey(session));
      if (raw) local = JSON.parse(raw) as SessionSnapshot;
    } catch {
      /* unreadable: ignore */
    }
    let remote: SessionSnapshot | null = null;
    try {
      remote = await library.session(session);
    } catch (e) {
      this.engine.info(`the patch library is unreachable (${(e as Error).message}); using this browser's copy`);
    }
    let best: SessionSnapshot | null = !remote ? local : !local ? remote : local.updated > remote.updated ? local : remote;
    if (allowLegacy && !hasContent(best?.doc)) {
      // Before sessions kept their own patches there was one autosave per browser.
      try {
        const raw = localStorage.getItem(LEGACY_PATCH_KEY);
        const legacy = raw && !localStorage.getItem(LEGACY_DONE_KEY) ? (JSON.parse(raw) as PatchDoc) : null;
        if (legacy && hasContent(legacy)) best = { doc: legacy, updated: 0 };
      } catch {
        /* ignore */
      }
    }
    return best ? { doc: migratePatch(best.doc), updated: best.updated } : null;
  }

  private markLegacyDone() {
    try {
      localStorage.setItem(LEGACY_DONE_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  }

  // ── the library ──────────────────────────────────────────────────────────

  showDialog(dialog: Dialog | null) {
    this.dialog = dialog;
    this.uiEvents.emit();
  }

  toggleNav(open = !this.navOpen) {
    this.navOpen = open;
    try {
      localStorage.setItem(NAV_KEY, open ? '1' : '0');
    } catch {
      /* ignore */
    }
    this.uiEvents.emit();
  }

  async refreshTree(): Promise<void> {
    try {
      this.tree = await library.tree();
      this.treeError = null;
    } catch (e) {
      this.treeError = (e as Error).message;
    }
    this.uiEvents.emit();
  }

  /** The current session as the library lists it (a brand-new one may not be listed yet). */
  get entry() {
    return this.tree.sessions.find((s) => s.name === this.session) ?? null;
  }

  get song() {
    return songOf(this.tree, this.session);
  }

  get set() {
    return setOf(this.tree, this.song);
  }

  /** What the agent reads besides the patch: its place, and the AGENTS.md files. */
  agentContext() {
    return contextOf(this.tree, this.session);
  }

  /** Make sure the library has this session: a brand-new one is only written on its first change. */
  private async ensureListed(name: string): Promise<void> {
    if (name !== this.session || this.tree.sessions.some((s) => s.name === name)) return;
    const doc = this.restored ? this.runtime.doc : (await this.snapshot)?.doc ?? emptyPatch();
    await library.putSession(name, { doc, updated: Date.now(), turns: this.turns });
    await this.refreshTree();
  }

  /** A session the server just made: listed at once (the next refresh confirms it). */
  private list(e: SessionEntry) {
    this.tree = { ...this.tree, sessions: [e, ...this.tree.sessions.filter((s) => s.name !== e.name)] };
  }

  /** Keep the listing in step with an autosave, without asking the server. */
  private listed(session: string, snap: SessionSnapshot & { turns: number }) {
    const e = this.tree.sessions.find((s) => s.name === session);
    if (!e) {
      void this.refreshTree();
      return;
    }
    e.title = snap.doc.title;
    e.modules = Object.keys(snap.doc.modules).length;
    e.turns = Math.max(e.turns, snap.turns);
    e.updated = snap.updated;
  }

  /** The chat counted the person's messages; the first one names a session nobody has named. */
  setTurns(turns: number, firstText?: string) {
    if (turns === this.turns) return;
    const was = this.turns;
    this.turns = turns;
    if (was === 0 && turns > 0 && firstText && this.runtime.doc.title === UNTITLED && this.state === 'ready') this.runtime.setTitle(titleFrom(firstText));
    else this.touched();
  }

  // ── sessions ──

  /** Go to a session: its conversation and its patch. */
  async openSession(name: string): Promise<void> {
    if (name === this.session) return;
    await this.switchSession(name, null);
    this.note('came back to this session');
  }

  /** A new session with an empty patch: at the top, or in a song. */
  async newSession(songId: string | null = null): Promise<void> {
    const name = freshSessionName();
    const doc = emptyPatch();
    try {
      this.list(await library.createSession(name, doc, songId));
    } catch (e) {
      // Offline: it starts at the top, and the first autosave lists it.
      this.engine.info(`couldn't make the session in the library (${(e as Error).message})`);
    }
    await this.switchSession(name, { doc, updated: Date.now() });
    await this.refreshTree();
  }

  /**
   * Branch: a new session from this one, beside it in the same song.
   *   'before' a message: the conversation up to it, the patch as it was when it was sent (then `send` goes there instead)
   *   'after' a message:  the conversation through that turn, the patch as the turn left it
   *   'all':  a copy of everything, going its own way from here (the patch keeps playing)
   *   'none': no conversation, this patch: a fresh start (the patch keeps playing)
   */
  async branch(opts: { keep: ForkKeep; at?: string | null; checkpoint?: string; send?: string; title?: string }): Promise<void> {
    await this.ensureListed(this.session);
    this.saveNow(false);
    const keepPatch = (opts.keep === 'all' || opts.keep === 'none') && !opts.checkpoint;
    const r = await library.fork(this.session, {
      keep: opts.keep,
      at: opts.at ?? null,
      ...(opts.checkpoint ? { checkpoint: opts.checkpoint } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(keepPatch ? { doc: this.runtime.doc } : {}),
    });
    const from = this.runtime.doc.title;
    const { doc: forkDoc, ...entry } = r.session;
    this.list(entry);
    const doc = migratePatch(forkDoc);
    if (opts.send) this.pendingSend = { session: r.session.name, text: opts.send, prefix: r.session.prefix };
    await this.switchSession(r.session.name, { doc, updated: Date.now() }, { keepPatch });
    await this.refreshTree();
    const what = opts.keep === 'none' ? `started afresh from '${from}' (same patch, no conversation)` : `branched from the session '${from}'${opts.keep === 'all' ? '' : ' at an earlier message'}`;
    this.note(what);
    if (r.approximate) this.showToast('That part of the conversation is older than checkpoints, so the branch starts with the patch as it is now.');
  }

  /** A copy of any session (from its latest), beside it, to go its own way. */
  async copySession(name: string): Promise<void> {
    if (name === this.session) return this.branch({ keep: 'all' });
    const r = await library.fork(name, { keep: 'all' });
    const { doc, ...entry } = r.session;
    this.list(entry);
    await this.switchSession(r.session.name, { doc: migratePatch(doc), updated: Date.now() });
    await this.refreshTree();
    this.note('opened a copy of another session (a branch of it)');
  }

  /** Clear the conversation: a fresh session with this patch (this one stays in the list). */
  freshStart(): Promise<void> {
    return this.branch({ keep: 'none' });
  }

  /** Send a different message where this one was, in a new branch (this one stays as it is). */
  editMessage(messageId: string, text: string): Promise<void> {
    return this.branch({ keep: 'before', at: messageId, send: text });
  }

  /** Go on differently from this answer, in a new branch. */
  branchAfter(messageId: string): Promise<void> {
    return this.branch({ keep: 'after', at: messageId });
  }

  /** A new branch from a checkpoint: its patch, and the conversation up to where it was made. */
  branchFromCheckpoint(id: string): Promise<void> {
    return this.branch({ keep: 'after', checkpoint: id });
  }

  renameSession(name: string, title: string) {
    const t = title.trim().slice(0, 120);
    if (!t) return;
    if (name === this.session) {
      this.runtime.setTitle(t);
      this.note(`renamed this session '${t}'`);
    }
    void this.libraryWrite(async () => {
      await this.ensureListed(name);
      await library.updateSession(name, { title: t });
    });
  }

  moveSession(name: string, songId: string | null) {
    const e = this.tree.sessions.find((s) => s.name === name);
    if (e) e.songId = songId;
    this.uiEvents.emit();
    void this.libraryWrite(async () => {
      await this.ensureListed(name);
      await library.updateSession(name, { songId });
    });
    if (name === this.session) {
      const song = songId ? this.tree.songs.find((x) => x.id === songId) : null;
      this.note(song ? `filed this session in the song '${song.name}'` : 'took this session out of its song');
    }
  }

  async deleteSession(name: string): Promise<void> {
    if (name === this.session) {
      // Somewhere to be first: the latest other session in the same place, or a new one there.
      const here = this.entry?.songId ?? null;
      const next = this.tree.sessions.filter((s) => s.name !== name && s.songId === here).sort((a, b) => b.updated - a.updated)[0];
      if (next) await this.switchSession(next.name, null);
      else await this.newSession(here);
    }
    await this.libraryWrite(() => library.removeSession(name));
  }

  // ── songs and sets ──

  async createSong(name: string, setId: string | null = null, fileSession?: string): Promise<string> {
    const song = await library.createSong(name, setId);
    if (fileSession) {
      await this.ensureListed(fileSession);
      await library.updateSession(fileSession, { songId: song.id });
    }
    await this.refreshTree();
    if (fileSession === this.session) this.note(`made the song '${name}' and filed this session in it`);
    return song.id;
  }

  async createSet(name: string): Promise<string> {
    const set = await library.createSet(name);
    await this.refreshTree();
    return set.id;
  }

  renameSong(id: string, name: string) {
    void this.libraryWrite(() => library.updateSong(id, { name }));
  }

  renameSet(id: string, name: string) {
    void this.libraryWrite(() => library.updateSet(id, { name }));
  }

  /** Put a song in a set (null: on its own), optionally at a place in it. */
  moveSong(id: string, setId: string | null, position?: number) {
    const song = this.tree.songs.find((x) => x.id === id);
    if (song) song.setId = setId;
    this.uiEvents.emit();
    void this.libraryWrite(() => library.updateSong(id, { setId, ...(position !== undefined ? { position } : {}) }));
  }

  /** Delete a song or a set; what's in it moves up a level, unless `everything`. */
  async deleteGroup(entry: Entry, everything: boolean): Promise<void> {
    const inside = (s: { songId: string | null }) =>
      entry.type === 'song' ? s.songId === entry.id : this.tree.songs.some((x) => x.setId === entry.id && x.id === s.songId);
    if (everything && this.entry && inside(this.entry)) {
      const elsewhere = this.tree.sessions.filter((s) => !inside(s)).sort((a, b) => b.updated - a.updated)[0];
      if (elsewhere) await this.switchSession(elsewhere.name, null);
      else await this.newSession(null);
    }
    await this.libraryWrite(() => (entry.type === 'song' ? library.removeSong(entry.id, everything) : library.removeSet(entry.id, everything)));
  }

  /** The AGENTS.md of a level: yours, a set's or a song's. */
  agentsOf(level: 'person' | 'song' | 'set', id?: string): string {
    if (level === 'person') return this.tree.agents;
    return (level === 'song' ? this.tree.songs : this.tree.sets).find((x) => x.id === id)?.agents ?? '';
  }

  async saveAgents(level: 'person' | 'song' | 'set', id: string | undefined, text: string): Promise<void> {
    if (level === 'person') {
      this.tree.agents = text;
      await library.setUserAgents(text);
    } else if (level === 'song' && id) {
      await library.updateSong(id, { agents: text });
    } else if (level === 'set' && id) {
      await library.updateSet(id, { agents: text });
    }
    await this.refreshTree();
  }

  /** The agent's context tool: write to the AGENTS.md of this session's song or set, or yours. */
  async writeContext(level: 'song' | 'set' | 'person', text: string, mode: 'append' | 'replace'): Promise<void> {
    await this.refreshTree();
    const song = this.song;
    const set = this.set;
    if (level === 'song' && !song) throw new Error("this session isn't in a song yet; the person can make one, or file it in one, from the library on the left");
    if (level === 'set' && !set) throw new Error(song ? `the song '${song.name}' isn't in a set` : "this session isn't in a song (or a set)");
    const id = level === 'song' ? song!.id : level === 'set' ? set!.id : undefined;
    const was = this.agentsOf(level, id);
    const next = mode === 'append' ? `${was.replace(/\s+$/, '')}${was.trim() ? '\n' : ''}${text.trim()}\n` : text;
    await this.saveAgents(level, id, next.slice(0, 60_000));
  }

  /** A write to the library, then the fresh listing (or the error, said). */
  private async libraryWrite(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.showToast(`the library said no: ${(e as Error).message}`, { error: true });
    }
    await this.refreshTree();
  }

  // ── checkpoints ──

  async loadCheckpoints(): Promise<void> {
    const session = this.session;
    try {
      const list = await library.checkpoints(session);
      if (session === this.session) this.checkpoints = list;
    } catch {
      /* the session isn't in the library yet */
    }
    this.uiEvents.emit();
  }

  /** A turn ended: keep the patch as it left it. */
  async afterTurn(messageId: string): Promise<void> {
    if (this.state !== 'ready') return;
    const session = this.session;
    try {
      await this.ensureListed(session);
      await library.putCheckpoint(session, { at: messageId, kind: 'after', doc: this.runtime.doc });
    } catch {
      /* offline: the next turn's 'before' has it too */
    }
    // With the one the agent kept when the message was sent.
    await this.loadCheckpoints();
  }

  /** ⌘S: keep the patch as it is now, by name, in this session's timeline. */
  async checkpointNow(label?: string): Promise<void> {
    if (this.state !== 'ready') return;
    this.saveNow(false);
    const name = label?.trim() || `checkpoint ${this.checkpoints.filter((k) => k.kind === 'manual').length + 1}`;
    try {
      await this.ensureListed(this.session);
      const k = await library.putCheckpoint(this.session, { at: this.lastMessageId, kind: 'manual', label: name, doc: this.runtime.doc });
      if (k) this.checkpoints = [...this.checkpoints, k];
      this.note(`kept a checkpoint of the patch: '${name}'`);
      this.showToast(`Checkpoint “${name}”: restore it, or branch from it, any time`);
    } catch (e) {
      this.showToast(`couldn't keep the checkpoint: ${(e as Error).message}`, { error: true });
    }
  }

  /** Bring a checkpoint's patch back into this session (⌘Z takes it away again). */
  async restoreCheckpoint(id: string): Promise<void> {
    if (this.state !== 'ready') return;
    const k = await library.checkpoint(this.session, id);
    if (!k) throw new Error('that checkpoint is gone');
    await this.restore(migratePatch(k.doc));
    const what = k.kind === 'manual' ? `the checkpoint '${k.label}'` : k.kind === 'before' ? 'the patch as it was before one of my earlier messages' : 'the patch as an earlier turn left it';
    this.note(`restored ${what} (${k.modules} modules)`);
  }

  /** A patch from a file: a new session holding it, beside this one. */
  async importPatch(raw: unknown): Promise<void> {
    const doc = raw as PatchDoc;
    if (!doc || typeof doc !== 'object' || typeof doc.modules !== 'object') throw new Error("that file isn't a patter patch");
    const name = freshSessionName();
    const migrated = migratePatch(doc);
    try {
      this.list(await library.createSession(name, migrated, this.entry?.songId ?? null));
    } catch {
      /* the first autosave lists it */
    }
    await this.switchSession(name, { doc: migrated, updated: Date.now() });
    await this.refreshTree();
    this.note(`imported the patch '${this.runtime.doc.title}' from a file`);
  }

  /** Empty this patch and keep talking (undoable). */
  async clearPatch(): Promise<void> {
    this.runtime.checkpoint();
    this.seq.stopAll();
    this.seq.clear();
    await this.runtime.clear();
    this.note('cleared the patch');
  }

  exportPatch(): string {
    return JSON.stringify(this.runtime.doc, null, 2);
  }

  /**
   * Leave this session (its patch is saved first) for another: one holding
   * `snap`, or an existing one (snap null). With keepPatch the running patch
   * stays as it is (a fresh start, a copy): only the conversation changes.
   */
  private async switchSession(next: string, snap: SessionSnapshot | null, opts: { keepPatch?: boolean } = {}): Promise<void> {
    this.stopAgent();
    this.saveNow(false);
    const live = this.state === 'ready';
    if (live && !opts.keepPatch) {
      if (this.stopped) this.play();
      this.restored = false;
      this.seq.stopAll();
      this.seq.clear();
      await this.runtime.clear();
    }
    this.session = next;
    try {
      localStorage.setItem(SESSION_KEY, next);
    } catch {
      /* ignore */
    }
    this.abandoned = this.loadAbandoned();
    this.actions = [];
    this.checkpoints = [];
    this.turns = 0;
    this.lastMessageId = null;
    if (!opts.keepPatch) {
      this.scope = '';
      this.selection = [];
      if (this.panel === 'selected') this.panel = 'performance';
    }
    this.uiEvents.emit();
    if (!live) {
      // Before audio starts: this is what start() will bring back.
      this.snapshot = snap ? Promise.resolve(snap) : this.fetchSnapshot(next);
      this.noteResumes();
      void this.loadCheckpoints();
      return;
    }
    if (opts.keepPatch) void this.loadCheckpoints();
    else await this.adopt(snap ?? (await this.fetchSnapshot(next)));
    this.saveNow(false);
    this.uiEvents.emit();
    this.patchEvents.emit();
  }

  // ── samples ──────────────────────────────────────────────────────────────

  /** A patch name for a file: its name as an identifier, or the name it already has here. */
  private sampleNameFor(file: string, src: string): string {
    const samples = this.runtime.doc.samples;
    const same = Object.entries(samples).find(([, x]) => x.src === src);
    if (same) return same[0];
    let base = file.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '').slice(0, 28) || 'sample';
    if (!/^[a-z]/.test(base)) base = `s_${base}`;
    let name = base;
    for (let n = 2; samples[name]; n++) name = `${base}_${n}`;
    return name;
  }

  /**
   * Audio files dropped on the page: into the patch under their names, and
   * into the library (by content hash) so the patch finds them again later.
   */
  async addFiles(files: File[]): Promise<string[]> {
    if (this.state !== 'ready') throw new Error('start audio first, then drop the files again');
    const audio = files.filter((f) => f.type.startsWith('audio/') || /\.(wav|aiff?|flac|mp3|ogg|oga|opus|m4a|aac|caf)$/i.test(f.name));
    const added: string[] = [];
    for (const f of audio) {
      this.incoming = [...this.incoming, f.name];
      this.uiEvents.emit();
      try {
        added.push(await this.addSampleBytes(await f.arrayBuffer(), f.name, f.type));
      } catch (e) {
        this.engine.info(`couldn't add ${f.name}: ${(e as Error).message}`);
      } finally {
        this.incoming = this.incoming.filter((x) => x !== f.name);
        this.uiEvents.emit();
      }
    }
    if (added.length) this.showPanel('samples');
    return added;
  }

  /** Audio bytes into the patch as a sample named after the file, and into the library. */
  private async addSampleBytes(bytes: ArrayBuffer, file: string, type: string, beats?: number): Promise<string> {
    const hash = await sha256(bytes);
    const src = `lib:${hash}`;
    this.bank.seed(src, bytes.slice(0));
    const name = this.sampleNameFor(file, src);
    this.runtime.checkpoint();
    const r = await this.runtime.defineSample(name, { src, file, ...(beats ? { beats } : {}) });
    try {
      await library.uploadSample(bytes, hash, { name: file, type, duration: r.sample.duration, channels: r.sample.channels });
    } catch (e) {
      this.engine.info(`'${file}' plays, but couldn't be saved to your library (${(e as Error).message}); it won't come back after a reload`);
    }
    const what = [`${Math.round(r.sample.duration * 100) / 100} s`, r.sample.beats ? `${r.sample.beats} beats` : '', r.analysis?.kind ?? ''].filter(Boolean).join(', ');
    this.note(`added the sample '${name}' from ${file} (${what})`);
    return name;
  }

  /**
   * Record `bars` bars of a module's output (or a subpatch's, or 'master',
   * the mix) into a new sample, from the next bar line. It's exactly that
   * many beats long, so it loops perfectly; it goes to the library too.
   */
  async record(source: string, bars: number, name?: string): Promise<string> {
    if (this.state !== 'ready') throw new Error('start audio first');
    if (this.recording) throw new Error('already recording');
    if (!(bars >= 1 && bars <= 32)) throw new Error('bars: 1 to 32');
    const rt = this.runtime;
    let bus: number, channels: 1 | 2, label: string;
    if (source === 'master') {
      [bus, channels, label] = [this.engine.masterBus, 2, 'mix'];
    } else {
      const path = rt.moduleFor(source);
      const live = rt.module(path)!;
      if (live.compiled.shape.rate !== 'audio') throw new Error(`'${source}' is a control signal; record an audio module, a subpatch or 'master'`);
      [bus, channels, label] = [live.bus, live.compiled.shape.channels === 1 ? 1 : 2, leafOf(path)];
    }
    const bps = this.seq.bpm / 60;
    const beats = bars * 4;
    const sr = this.engine.sampleRate;
    const frames = Math.round((beats / bps) * sr);
    const bufnum = await this.bank.allocScratch(frames, channels);
    const id = this.engine.nextNodeId();
    // Up to a bar's wait for the bar line, then the bars, then some slack.
    const ended = this.engine.nodeEnded(id, ((beats + 4) / bps + 5) * 1000);
    this.engine.send('/s_new', `patter_recorder_${channels}`, id, 1, GROUPS.monitor, 'inBus', bus, 'buf', bufnum);
    this.recording = { source, bars, started: Date.now() };
    this.uiEvents.emit();
    try {
      await ended;
    } catch (e) {
      this.engine.send('/n_free', id);
      this.bank.freeScratch(bufnum);
      throw new Error(`the recording didn't finish (${(e as Error).message})`);
    } finally {
      this.recording = null;
      this.uiEvents.emit();
    }
    const pcm = await this.engine.readBuffer(bufnum, frames, channels);
    const wav = floatWav(pcm, channels, sr);
    const hash = await sha256(wav);
    const src = `lib:${hash}`;
    const split = Array.from({ length: channels }, (_, c) => Float32Array.from({ length: frames }, (_, i) => pcm[i * channels + c]));
    this.bank.adopt(src, bufnum, split, sr);
    const file = `${label} recording (${bars} bar${bars === 1 ? '' : 's'}).wav`;
    try {
      await library.uploadSample(wav, hash, { name: file, type: 'audio/wav', duration: frames / sr, channels });
    } catch (e) {
      this.engine.info(`the recording plays, but couldn't be saved to your library (${(e as Error).message})`);
    }
    const sampleName = name ?? this.sampleNameFor(`${label}_rec`, src);
    rt.checkpoint();
    await rt.defineSample(sampleName, { src, file, beats });
    this.note(`recorded ${bars} bar${bars === 1 ? '' : 's'} of ${label} as the sample '${sampleName}'`);
    return sampleName;
  }

  /** Play a patch sample once into the mix (the Samples tab's ▶). */
  audition(name: string) {
    const doc = this.runtime.doc.samples[name];
    const loaded = doc && this.bank.get(doc.src);
    if (!loaded || this.state !== 'ready') return;
    const id = this.engine.nextNodeId();
    this.engine.send('/s_new', `patter_audition_${loaded.channels === 1 ? 1 : 2}`, id, 1, GROUPS.monitor, 'buf', loaded.bufnum, 'out', this.engine.masterBus);
  }

  // ── the transport ────────────────────────────────────────────────────────

  /**
   * Stop (⌘.): the agent's turn, the routines and the sound — the node tree
   * freezes where it is, so play picks up exactly there.
   */
  stop() {
    this.stopAgent();
    if (this.state !== 'ready' || this.stopped) return;
    this.stopped = true;
    this.pausedRoutines = this.seq.list().filter((r) => r.playing).map((r) => r.name);
    this.seq.stopAll();
    this.recorder.endNow(0.15);
    this.engine.pause();
    this.recorder.setStopped(true);
    // Notes already scheduled would all start together on play: end them, after the fade.
    setTimeout(() => this.runtime.silenceVoices(), 120);
    this.note('stopped the sound (⌘.)');
    this.uiEvents.emit();
  }

  play() {
    if (!this.stopped) return;
    this.stopped = false;
    this.engine.resume(this.runtime.doc.master.level);
    this.recorder.setStopped(false);
    for (const name of this.pausedRoutines) {
      try {
        this.seq.play(name);
      } catch {
        /* removed while stopped */
      }
    }
    this.pausedRoutines = [];
    this.note('started the sound again');
    this.uiEvents.emit();
  }

  toggleTransport() {
    if (this.stopped) this.play();
    else this.stop();
  }

  // ── recording the mix ────────────────────────────────────────────────────

  /** ● REC (⌥R): record the mix from the next bar line; again, end it on the bar line after. */
  toggleRecord() {
    if (this.state !== 'ready') return;
    if (this.stopped && !this.recorder.rec) this.play();
    this.recorder.toggle();
  }

  /** ⟲ (⌥C): keep the last minutes of the mix as a take. */
  async capture(): Promise<void> {
    if (this.state !== 'ready') return;
    await this.recorder.capture();
  }

  private tookTake(take: Take) {
    const time = formatTime(take.frames / take.sampleRate);
    const what =
      take.kind === 'recording'
        ? `recorded ${take.bars ? `${take.bars} bar${take.bars === 1 ? '' : 's'} (${time})` : time} of the mix`
        : `captured the last ${time} of the mix`;
    this.note(`${what}: '${take.name}'`);
    const warn = take.volatile ? " — this browser wouldn't store it, so download it before you leave" : '';
    this.showToast(`${what[0].toUpperCase()}${what.slice(1)}: ${take.name}${warn}`, { take: take.id });
    if (this.settings.autoDownload) void this.downloadTake(take.id);
  }

  takeById(id: string): Take | undefined {
    return this.recorder.takes.find((t) => t.id === id);
  }

  /** Save a take's WAV file (24-bit) to the person's computer. */
  async downloadTake(id: string): Promise<void> {
    const take = this.takeById(id);
    if (!take) return;
    const url = URL.createObjectURL(await this.recorder.wav(take));
    const a = document.createElement('a');
    a.href = url;
    a.download = takeFileName(take);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /** A take into the patch as a sample (and the library); a whole-bar recording knows its beats. */
  async takeToPatch(id: string): Promise<string | null> {
    const take = this.takeById(id);
    if (!take || this.state !== 'ready') return null;
    const wav = await this.recorder.wav(take);
    if (wav.size > 60e6) {
      this.showToast(`${take.name} is too long to be a sample (${formatTime(take.frames / take.sampleRate)}); download it instead`, { error: true });
      return null;
    }
    try {
      const name = await this.addSampleBytes(await wav.arrayBuffer(), `${take.name}.wav`, 'audio/wav', take.bars ? take.bars * 4 : undefined);
      this.showPanel('samples');
      return name;
    } catch (e) {
      this.showToast(`couldn't make ${take.name} a sample: ${(e as Error).message}`, { error: true });
      return null;
    }
  }

  async removeTake(id: string): Promise<void> {
    const take = this.takeById(id);
    if (take) await this.recorder.remove(take);
  }

  async renameTake(id: string, name: string): Promise<void> {
    const take = this.takeById(id);
    if (take) await this.recorder.rename(take, name);
  }

  showToast(text: string, opts: { take?: string; error?: boolean } = {}) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toast = { id: (this.toast?.id ?? 0) + 1, text, ...opts };
    this.toastTimer = setTimeout(() => this.dismissToast(), opts.take ? 12_000 : 6_000);
    this.uiEvents.emit();
  }

  dismissToast() {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.toast = null;
    this.uiEvents.emit();
  }

  /** A change on the mixer, for the agent (it leaves the mix to the person). */
  mixed(what: string) {
    this.note(`mixer: ${what}`);
  }

  // ── the agent ────────────────────────────────────────────────────────────

  /** Stop the agent's turn: the stream, and every tool call not yet run (now or after a reload). */
  stopAgent() {
    this.agentGeneration++;
    this.chatStop();
    // Tool calls waiting for audio wake up, see the new generation, and give up.
    for (const w of this.readyWaiters.splice(0)) w();
    this.uiEvents.emit();
  }

  /** A tool call (of `session`'s conversation) that will never run. */
  abandon(toolCallId: string, session = this.session) {
    const set = session === this.session ? this.abandoned : this.loadAbandoned(session);
    set.add(toolCallId);
    try {
      localStorage.setItem(abandonedKey(session), JSON.stringify([...set].slice(-400)));
    } catch {
      /* ignore */
    }
    this.uiEvents.emit();
  }

  private loadAbandoned(session = this.session): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(abandonedKey(session)) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  }

  /** Remember something the user did by hand, for the agent. */
  note(what: string) {
    this.actions.push({ at: Date.now(), what });
    if (this.actions.length > 12) this.actions.shift();
  }

  /** The user's recent actions, as the agent sees them. */
  recentActions(): string[] {
    const now = Date.now();
    return this.actions.filter((a) => now - a.at < 30 * 60_000).slice(-6).map((a) => `${ago(now - a.at)} ago: ${a.what}`);
  }

  // ── settings ─────────────────────────────────────────────────────────────

  updateSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    if (patch.captureMinutes !== undefined) this.recorder.setMinutes(patch.captureMinutes);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    this.uiEvents.emit();
  }

  // ── focus: where the user is looking ────────────────────────────────────

  /** The single selected node, if exactly one is selected. */
  get selected(): string | null {
    return this.selection.length === 1 ? this.selection[0] : null;
  }

  /** Select a node (add: toggle it in a multi-selection; stay: keep the knob area on what it shows); null clears. */
  select(id: string | null, opts: { add?: boolean; stay?: boolean } = {}) {
    if (id === null) this.selection = [];
    else if (opts.add) this.selection = this.selection.includes(id) ? this.selection.filter((x) => x !== id) : [...this.selection, id];
    else this.selection = [id];
    if (!opts.stay) this.panel = this.selection.length ? 'selected' : 'performance';
    this.uiEvents.emit();
  }

  selectMany(ids: string[]) {
    this.selection = [...new Set(ids)];
    this.panel = this.selection.length ? 'selected' : 'performance';
    this.uiEvents.emit();
  }

  /**
   * Point at something the agent just made: select it (or the subpatch here
   * that contains it) without taking the knob area away from what it shows.
   */
  reveal(path: string) {
    const scope = this.scope;
    if (scope && !path.startsWith(`${scope}/`)) return;
    const rest = scope ? path.slice(scope.length + 1) : path;
    this.selection = [scope ? `${scope}/${rest.split('/')[0]}` : rest.split('/')[0]];
    this.uiEvents.emit();
  }

  /** Show a subpatch's insides in the graph. */
  enter(path: string) {
    this.scope = path;
    this.selection = [];
    this.panel = 'performance';
    this.uiEvents.emit();
  }

  /** Go up one level, with the subpatch we left selected. */
  up() {
    if (!this.scope) return;
    const from = this.scope;
    this.scope = parentOf(from);
    this.selection = [from];
    this.panel = 'selected';
    this.uiEvents.emit();
  }

  showPanel(panel: Panel) {
    this.panel = panel;
    this.uiEvents.emit();
  }

  /** After the patch changes underneath: drop selections that vanished, climb out of a scope that did. */
  private keepFocusValid() {
    const doc = this.runtime.doc;
    const exists = (id: string) => (id.startsWith('macro:') ? Boolean(doc.macros[id.slice(6)]) : Boolean(doc.modules[id] || doc.subpatches[id]));
    let scope = this.scope;
    while (scope && !doc.subpatches[scope]) scope = parentOf(scope);
    const selection = this.selection.filter(exists);
    if (scope !== this.scope || selection.length !== this.selection.length) {
      this.scope = scope;
      this.selection = selection;
      if (!selection.length && this.panel === 'selected') this.panel = 'performance';
      this.uiEvents.emit();
    }
  }
}

export const app = new App();
// Handy from the console (and for driving the app in tests).
(globalThis as unknown as { patter: App }).patter = app;

export function useEmitter(e: Emitter): number {
  return useSyncExternalStore(e.on, () => e.version);
}

export type { EngineLogEntry };
