// The app: one engine, one runtime, one sequencer (the agent lives in a
// Cloudflare Durable Object; see worker/) — the session they belong to, the
// transport, and the small bits of UI state React subscribes to.
//
// A session is one conversation with the agent and the patch it's about. Its
// patch autosaves (to this browser and to the patch library on the server),
// and comes back when the page does: audio starts on a click, then the patch
// loads, then any tool calls the agent left waiting run against it.

import { useSyncExternalStore } from 'react';
import { Engine, type EngineLogEntry } from '../engine/engine';
import { Runtime } from '../runtime/runtime';
import { Sequencer } from '../seq/sequencer';
import { emptyPatch, migratePatch, parentOf, type PatchDoc } from '../runtime/patch';
import { library, type SessionSnapshot } from './library';

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
}

export type Dialog = 'save-as' | 'open' | 'rename' | 'new' | 'clear';

function loadSettings(): Settings {
  const dflt: Settings = { effort: 'low', autoSendVoice: true };
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
  readonly runtime = new Runtime(this.engine);
  readonly seq = new Sequencer(this.runtime, this.engine);

  readonly patchEvents = new Emitter();
  readonly uiEvents = new Emitter();
  readonly logEvents = new Emitter();

  /** off → (click) booting → restoring (the session's patch) → ready. */
  state: 'off' | 'booting' | 'restoring' | 'ready' | 'error' = 'off';
  bootError = '';
  /** The subpatch the graph shows ('' = the top level). */
  scope = '';
  /** Selected graph nodes: module and subpatch paths, 'macro:<path>'. */
  selection: string[] = [];
  /** What the knob area shows: the scope's Performance Panel, or the selection. */
  panel: 'performance' | 'selected' = 'performance';
  /** The open patch dialog, if any. */
  dialog: Dialog | null = null;
  settings: Settings = loadSettings();

  // ── the session ──
  /** The conversation (the agent Durable Object's name) and the patch that goes with it. */
  session = loadSessionName();
  /** The saved patch the working patch was opened from or last saved as. */
  libraryId: string | null = null;
  /** What this session will bring back, known before audio starts (for the start screen). */
  resumes: { title: string; modules: number } | null = null;
  /** Bumped by every change to the patch; equal to savedRevision when the library copy is current. */
  revision = 0;
  savedRevision = 0;
  /** The last autosave to the server. */
  autosave: 'idle' | 'saving' | 'saved' | 'offline' = 'idle';
  private snapshot: Promise<SessionSnapshot | null>;
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
  /** Set by the chat panel: stop the stream; wipe the agent's history. */
  chatStop: () => void = () => {};
  clearConversation: () => void = () => {};

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
    this.snapshot = this.fetchSnapshot(this.session, true);
    void this.snapshot.then((snap) => {
      if (snap && hasContent(snap.doc)) this.resumes = { title: snap.doc.title, modules: Object.keys(snap.doc.modules).length };
      this.uiEvents.emit();
    });
    window.addEventListener('pagehide', () => this.saveNow(true));
  }

  // ── starting ─────────────────────────────────────────────────────────────

  /** Start audio (browsers need a click for that), then bring back this session's patch. */
  async start(): Promise<void> {
    if (this.state === 'booting' || this.state === 'restoring' || this.state === 'ready') return;
    this.state = 'booting';
    this.uiEvents.emit();
    try {
      await this.engine.boot();
      this.seq.setBpm(this.runtime.doc.bpm);
      this.seq.start();
    } catch (e) {
      this.state = 'error';
      this.bootError = String((e as Error)?.message ?? e);
      this.uiEvents.emit();
      return;
    }
    if (!this.restored) {
      this.state = 'restoring';
      this.uiEvents.emit();
      const snap = await this.snapshot;
      await this.adopt(snap);
      if (snap?.updated === 0) this.markLegacyDone();
    }
    this.state = 'ready';
    this.uiEvents.emit();
    for (const w of this.readyWaiters.splice(0)) w();
  }

  /** Resolves once audio runs and the session's patch is back — or the agent's turn was stopped. */
  whenReady(): Promise<void> {
    return this.state === 'ready' ? Promise.resolve() : new Promise((resolve) => this.readyWaiters.push(resolve));
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
    this.libraryId = snap?.libraryId ?? null;
    this.savedRevision = snap?.dirty ? -1 : this.revision;
    this.runtime.resetHistory();
    this.restored = true;
  }

  async restore(doc: PatchDoc): Promise<string[]> {
    const errors = await this.runtime.loadPatch(doc);
    this.seq.setBpm(doc.bpm || 110);
    errors.push(...this.seq.load(doc.routines ?? {}));
    if (errors.length) this.engine.info(`restored with problems: ${errors.join('; ')}`);
    return errors;
  }

  // ── autosave ─────────────────────────────────────────────────────────────

  /** Unsaved changes since the patch was last saved to (or opened from) the library. */
  get dirty(): boolean {
    return this.revision !== this.savedRevision;
  }

  private touched() {
    this.revision++;
    if (!this.restored) return;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.saveNow(false), 1000);
  }

  /** Write the session's patch: to this browser now, to the server as well. */
  private saveNow(unloading: boolean) {
    if (!this.restored) return;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    const snap: SessionSnapshot = { doc: this.runtime.doc, libraryId: this.libraryId, dirty: this.dirty, updated: Date.now() };
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
    library.putSession(this.session, snap).then(
      () => {
        this.autosave = 'saved';
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
    let best = !remote ? local : !local ? remote : local.updated > remote.updated ? local : remote;
    if (allowLegacy && !hasContent(best?.doc)) {
      // Before sessions kept their own patches there was one autosave per browser.
      try {
        const raw = localStorage.getItem(LEGACY_PATCH_KEY);
        const legacy = raw && !localStorage.getItem(LEGACY_DONE_KEY) ? (JSON.parse(raw) as PatchDoc) : null;
        if (legacy && hasContent(legacy)) best = { doc: legacy, libraryId: null, dirty: true, updated: 0 };
      } catch {
        /* ignore */
      }
    }
    return best ? { ...best, doc: migratePatch(best.doc) } : null;
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

  /** ⌘S: update the saved patch this came from, or ask for a name. */
  async save(): Promise<void> {
    if (!this.libraryId) return this.showDialog('save-as');
    const doc = this.runtime.doc;
    const r = await library.update(this.libraryId, doc.title, doc);
    if (!r) {
      // Deleted from the library since: save it as a new one.
      this.libraryId = null;
      return this.showDialog('save-as');
    }
    this.savedRevision = this.revision;
    this.note(`saved the patch ('${doc.title}')`);
    this.saveNow(false);
    this.uiEvents.emit();
  }

  /** Save under a (new) name: the patch takes that title. */
  async saveAs(name: string): Promise<void> {
    if (name.trim() && name.trim() !== this.runtime.doc.title) this.runtime.setTitle(name);
    const r = await library.create(this.runtime.doc.title, this.runtime.doc);
    this.libraryId = r.id;
    this.savedRevision = this.revision;
    this.note(`saved the patch as '${r.name}'`);
    this.saveNow(false);
    this.uiEvents.emit();
  }

  rename(name: string) {
    this.runtime.setTitle(name);
    this.note(`renamed the patch '${this.runtime.doc.title}'`);
  }

  /** Open a saved patch: it gets a fresh session (this one stays under Recent). */
  async openPatch(id: string): Promise<void> {
    const p = await library.get(id);
    if (!p) throw new Error('that patch is no longer in the library');
    await this.switchSession(freshSessionName(), { doc: migratePatch(p.doc), libraryId: id, dirty: false, updated: Date.now() });
    this.note(`opened the saved patch '${p.name}' (a fresh conversation)`);
  }

  /** Go back to an earlier session: its conversation and its patch. */
  async resumeSession(name: string): Promise<void> {
    if (name === this.session) return;
    await this.switchSession(name, null);
    this.note('came back to this session');
  }

  /** A new, empty patch with a fresh conversation (this one stays under Recent). */
  async newPatch(): Promise<void> {
    await this.switchSession(freshSessionName(), { doc: emptyPatch(), libraryId: null, dirty: false, updated: Date.now() });
  }

  /** A patch from a file: like opening one, not linked to the library. */
  async importPatch(raw: unknown): Promise<void> {
    const doc = raw as PatchDoc;
    if (!doc || typeof doc !== 'object' || typeof doc.modules !== 'object') throw new Error("that file isn't a patter patch");
    await this.switchSession(freshSessionName(), { doc: migratePatch(doc), libraryId: null, dirty: true, updated: Date.now() });
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
   * Leave this session (its patch is saved first, and it stays under Recent)
   * for another: a fresh one holding `snap`, or an existing one (snap null).
   */
  private async switchSession(next: string, snap: SessionSnapshot | null): Promise<void> {
    this.stopAgent();
    this.saveNow(false);
    if (this.stopped) this.play();
    this.restored = false;
    this.seq.stopAll();
    this.seq.clear();
    await this.runtime.clear();
    this.session = next;
    try {
      localStorage.setItem(SESSION_KEY, next);
    } catch {
      /* ignore */
    }
    this.abandoned = this.loadAbandoned();
    this.actions = [];
    this.scope = '';
    this.selection = [];
    this.panel = 'performance';
    this.uiEvents.emit();
    await this.adopt(snap ?? (await this.fetchSnapshot(next)));
    this.saveNow(false);
    this.uiEvents.emit();
    this.patchEvents.emit();
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
    this.engine.pause();
    // Notes already scheduled would all start together on play: end them, after the fade.
    setTimeout(() => this.runtime.silenceVoices(), 120);
    this.note('stopped the sound (⌘.)');
    this.uiEvents.emit();
  }

  play() {
    if (!this.stopped) return;
    this.stopped = false;
    this.engine.resume(this.runtime.doc.master.level);
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

  /** Select a node (add: toggle it in a multi-selection); null clears. */
  select(id: string | null, opts: { add?: boolean } = {}) {
    if (id === null) this.selection = [];
    else if (opts.add) this.selection = this.selection.includes(id) ? this.selection.filter((x) => x !== id) : [...this.selection, id];
    else this.selection = [id];
    this.panel = this.selection.length ? 'selected' : 'performance';
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

  showPanel(panel: 'performance' | 'selected') {
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
      if (!selection.length) this.panel = 'performance';
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
