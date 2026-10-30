// On air: one session at a time, broadcast from the host's page to anyone
// listening. The host's browser publishes (PUT /api/on-air, behind Access);
// the OnAir Durable Object keeps the latest of everything and sends it to
// every listener's WebSocket (GET /listen). This file is shared by the page
// and the Worker: the shapes on the wire, their limits, and OnAirState, what
// the Durable Object does with an update (kept free of the platform, so tests
// can run it).

import type { PatchDoc } from '../runtime/patch';

/** A tool call as listeners see it: which tool, about what, and how it went. */
export interface TranscriptTool {
  type: 'tool';
  name: string;
  subject: string;
  state: 'ok' | 'error' | 'stopped';
  /** The start of what it returned. */
  result?: string;
}
export type TranscriptPart = { type: 'text'; text: string } | TranscriptTool;
/** A message of the conversation on air: the host's prompt, or the agent's reply. */
export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: TranscriptPart[];
}

export interface OnAirStatus {
  /** Broadcasting now. Off air, the last of everything is kept (and still plays). */
  live: boolean;
  /** The session on air and its title; null until something has been on air. */
  session: string | null;
  title: string;
  /** The host's tempo, and whether the host stopped the sound (⌘.). */
  bpm: number;
  stopped: boolean;
  /** When it last went on or off air, and when anything last changed. */
  since: number;
  updatedAt: number;
}

/** What a listener is sent: everything on connect, then each change. */
export type OnAirMessage =
  | { type: 'status'; status: OnAirStatus }
  | { type: 'patch'; session: string; doc: PatchDoc; updatedAt: number }
  | { type: 'transcript'; session: string; messages: TranscriptMessage[] };

/** What the host's page sends (PUT /api/on-air). */
export interface OnAirUpdate {
  /** The page sending it (each tab has its own id): while one is on air, the others' updates are refused. */
  publisher: string;
  /** true: go on air (or take it over from another tab); false: go off air. */
  live?: boolean;
  session?: string;
  title?: string;
  doc?: PatchDoc;
  transcript?: TranscriptMessage[];
  bpm?: number;
  stopped?: boolean;
}

/** An update refused: another tab is on air, or nothing is. */
export type OnAirRefusal = { ok: false; reason: 'elsewhere' | 'off' };
/** An update kept, with the messages for every listener; or refused. */
export type OnAirResult = { ok: true; status: OnAirStatus; messages: string[] } | OnAirRefusal;

/** What's on air, in one piece (GET /listen/state). */
export interface OnAirSnapshot {
  status: OnAirStatus;
  doc: PatchDoc | null;
  transcript: TranscriptMessage[];
}

export const NOTHING_ON_AIR: OnAirStatus = { live: false, session: null, title: '', bpm: 0, stopped: false, since: 0, updatedAt: 0 };

/** SQLite values in a Durable Object are capped at 2 MB; a conversation keeps its newest messages within this. */
export const MAX_TRANSCRIPT_CHARS = 1_000_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_RESULT_CHARS = 240;
const MAX_SUBJECT_CHARS = 160;

const SHA256 = /^[0-9a-f]{64}$/;

/** The library samples (SHA-256s) a patch plays: the only ones a listener may fetch. */
export function librarySamples(doc: { samples?: Record<string, { src?: unknown }> } | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const s of Object.values(doc?.samples ?? {})) {
    const src = s?.src;
    if (typeof src === 'string' && src.startsWith('lib:') && SHA256.test(src.slice(4))) out.add(src.slice(4));
  }
  return out;
}

/**
 * A conversation as sent, made safe to keep and show: known shapes only,
 * long text cut short, the oldest messages dropped until it fits. Null if
 * it isn't a conversation at all.
 */
export function cleanTranscript(v: unknown): TranscriptMessage[] | null {
  if (!Array.isArray(v)) return null;
  const out: TranscriptMessage[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return null;
    const { id, role, parts } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || (role !== 'user' && role !== 'assistant') || !Array.isArray(parts)) return null;
    const clean: TranscriptPart[] = [];
    for (const p of parts as Record<string, unknown>[]) {
      if (p?.type === 'text' && typeof p.text === 'string') {
        clean.push({ type: 'text', text: p.text.slice(0, MAX_TEXT_CHARS) });
      } else if (p?.type === 'tool' && typeof p.name === 'string') {
        clean.push({
          type: 'tool',
          name: p.name.slice(0, 60),
          subject: typeof p.subject === 'string' ? p.subject.slice(0, MAX_SUBJECT_CHARS) : '',
          state: p.state === 'error' || p.state === 'stopped' ? p.state : 'ok',
          ...(typeof p.result === 'string' ? { result: p.result.slice(0, MAX_RESULT_CHARS) } : {}),
        });
      }
    }
    out.push({ id: id.slice(0, 100), role, parts: clean });
  }
  let size = JSON.stringify(out).length;
  while (size > MAX_TRANSCRIPT_CHARS && out.length) size -= JSON.stringify(out.shift()).length + 1;
  return out;
}

/** Where the broadcast keeps its state: the Durable Object's SQLite, or a test's map. */
export interface OnAirStore {
  get(key: OnAirKey): string | null;
  put(key: OnAirKey, value: string): void;
}
/** The status, the patch and conversation messages as sent, the R2 prefix of the library on air, and the tab on air. */
export type OnAirKey = 'status' | 'patch' | 'transcript' | 'owner' | 'publisher';

/**
 * What the OnAir Durable Object does: keep the latest status, patch and
 * conversation (as the messages listeners are sent), take updates from the
 * tab that's on air and no other, and answer which library samples a
 * listener may have.
 */
export class OnAirState {
  /** The library samples of the patch on air, worked out once per patch. */
  private plays: { patch: string; hashes: Set<string> } | null = null;

  constructor(private readonly store: OnAirStore) {}

  status(): OnAirStatus {
    const raw = this.store.get('status');
    return { ...NOTHING_ON_AIR, ...(raw ? (JSON.parse(raw) as Partial<OnAirStatus>) : {}) };
  }

  /** What a listener is sent on connect: the status, then the patch and the conversation on air, if any. */
  welcome(): string[] {
    const out = [JSON.stringify({ type: 'status', status: this.status() } satisfies OnAirMessage)];
    for (const key of ['patch', 'transcript'] as const) {
      const m = this.store.get(key);
      if (m) out.push(m);
    }
    return out;
  }

  snapshot(): OnAirSnapshot {
    const patch = this.store.get('patch');
    const transcript = this.store.get('transcript');
    return {
      status: this.status(),
      doc: patch ? (JSON.parse(patch) as { doc: PatchDoc }).doc : null,
      transcript: transcript ? (JSON.parse(transcript) as { messages: TranscriptMessage[] }).messages : [],
    };
  }

  /** Whether `publisher` is the tab on air. */
  isPublisher(publisher: string): boolean {
    return this.status().live && this.store.get('publisher') === publisher;
  }

  /**
   * An update from the host's page. Going on air (live: true) takes the
   * broadcast from whichever tab had it; going off air is taken from any of
   * the host's pages; anything else only from the tab on air. A new session
   * starts with an empty conversation until its own arrives. `owner` is the
   * R2 prefix of the host's library, where the patch's samples are.
   */
  publish(u: OnAirUpdate, owner: string, now = Date.now()): OnAirResult {
    const was = this.status();
    if (u.live === undefined) {
      if (!was.live) return { ok: false, reason: 'off' };
      if (this.store.get('publisher') !== u.publisher) return { ok: false, reason: 'elsewhere' };
    }
    if (u.live) this.store.put('publisher', u.publisher);
    const status: OnAirStatus = { ...was, updatedAt: now };
    if (u.live !== undefined && u.live !== was.live) {
      status.live = u.live;
      status.since = now;
    }
    if (u.session !== undefined) status.session = u.session;
    if (u.title !== undefined) status.title = u.title;
    if (u.bpm !== undefined) status.bpm = u.bpm;
    if (u.stopped !== undefined) status.stopped = u.stopped;
    this.store.put('status', JSON.stringify(status));
    const messages = [JSON.stringify({ type: 'status', status } satisfies OnAirMessage)];
    const session = status.session;
    if (session && u.doc) {
      const m = JSON.stringify({ type: 'patch', session, doc: u.doc, updatedAt: now } satisfies OnAirMessage);
      this.store.put('patch', m);
      this.store.put('owner', owner);
      messages.push(m);
    }
    if (session && (u.transcript || session !== was.session)) {
      const m = JSON.stringify({ type: 'transcript', session, messages: u.transcript ?? [] } satisfies OnAirMessage);
      this.store.put('transcript', m);
      messages.push(m);
    }
    return { ok: true, status, messages };
  }

  /** The R2 prefix of the library holding a sample, while the patch on air plays it (null otherwise). */
  sampleOwner(hash: string): string | null {
    const patch = this.store.get('patch');
    if (!patch) return null;
    if (this.plays?.patch !== patch) this.plays = { patch, hashes: librarySamples((JSON.parse(patch) as { doc: PatchDoc }).doc) };
    return this.plays.hashes.has(hash) ? this.store.get('owner') : null;
  }
}
