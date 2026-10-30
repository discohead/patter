// Recording the mix, and capturing what it just played.
//
// ● REC (⌥R) arms a recording for the next bar line; pressed again, the take
// ends on the bar line after that: whole bars, so it loops. A press that
// lands just after a bar line (within GRACE) means that bar line, since hands
// are a little late. A third press, while it waits to end, ends it there.
// ⟲ (⌥C) keeps the last N minutes (settings) whenever it's pressed: the tap's
// ring has been listening all along. Both become takes, kept in this browser.
//
// Bar lines come from the client clock, the grid routines are scheduled on:
// a beat's NTP time maps to the AudioContext frame the engine plays it at
// (nowAt(t) = t + K, so frame = (ntp - K) * sampleRate), and the tap stamps
// every chunk with its frame. What the tap hears left the master's limiter,
// which delays everything by MASTER_DELAY: a bar line is that much later
// in the recording (and in the speakers) than on the grid.

import type { Engine } from '../engine/engine';
import { MASTER_DELAY } from '../engine/system-defs';
import { MixTap, type TapSource } from '../engine/tap';
import { PEAK_SECONDS, Peaks, pcm24, TakeStore, takeWav, type Take } from './takes';

const BAR = 4;
const GRACE = 0.1;
const PART_SECONDS = 2;
/** −80 dBFS: what a capture trims off its ends. */
const SILENCE = 1e-4;

export interface Recording {
  phase: 'armed' | 'recording' | 'finishing' | 'saving';
  startFrame: number;
  startBeat: number;
  /** Where it ends, once ● is pressed again (or ⌘.). */
  endFrame: number | null;
  /** The bar line it ends on; null when it was ended off the grid. */
  endBeat: number | null;
  bpm: number;
  take: Take | null;
  /** Frames written so far, from startFrame. */
  written: number;
}

export interface RecorderHooks {
  changed(): void;
  patchTitle(): string;
  /** A take is finished and stored. */
  finished(take: Take): void;
  /** Something to tell the person. */
  problem(message: string): void;
}

export function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export class Recorder {
  readonly tap: MixTap;
  readonly store = new TakeStore();
  /** Newest first. */
  takes: Take[] = [];
  rec: Recording | null = null;
  capturing = false;
  private minutes = 5;
  private stopped = false;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private peaks: Peaks | null = null;
  private part = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly engine: Engine,
    private readonly hooks: RecorderHooks,
  ) {
    this.tap = new MixTap(() => ({ ctx: engine.sonic.audioContext, node: engine.sonic.node as unknown as TapSource['node'] }));
    this.tap.onChunk(() => this.pump());
    void this.load();
  }

  /** Start listening (once audio runs): the capture buffer fills from here. */
  async start(minutes: number): Promise<void> {
    this.minutes = minutes;
    await this.tap.start(minutes);
    this.hooks.changed();
  }

  get available(): boolean {
    return this.tap.running;
  }

  /** How long a capture keeps. */
  setMinutes(minutes: number): void {
    this.minutes = minutes;
    this.tap.setMinutes(minutes);
  }

  /** The sound is stopped (⌘.): the capture buffer keeps what came before, not the silence. */
  setStopped(stopped: boolean): void {
    this.stopped = stopped;
    this.applyPause();
  }

  // ── where we are ──

  private clock() {
    const clock = this.engine.sonic.clock;
    const ctx = this.engine.sonic.audioContext;
    return clock && ctx ? { clock, ctx, sr: ctx.sampleRate, k: clock.nowAt(0) } : null;
  }

  /** The AudioContext time of what's coming out of the speakers now. */
  private heard(ctx: AudioContext): number {
    try {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime && ts.performanceTime) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    } catch {
      /* not in every browser */
    }
    return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
  }

  /** The beat being heard now. */
  beatNow(): number | null {
    const c = this.clock();
    return c ? c.clock.beatAtTime(this.heard(c.ctx) - MASTER_DELAY + c.k, BAR) : null;
  }

  /** Seconds of the recording heard so far. */
  elapsed(): number {
    const r = this.rec;
    const c = this.clock();
    if (!r || !c || r.phase === 'armed') return 0;
    return Math.max(0, this.heard(c.ctx) - r.startFrame / c.sr);
  }

  /** The bar line to start or end on: the next one, or one that passed less than GRACE ago. */
  private barLine(): { beat: number; frame: number } | null {
    const c = this.clock();
    if (!c) return null;
    const beat = c.clock.beatAtTime(this.heard(c.ctx) - MASTER_DELAY + c.k, BAR);
    let bar = Math.floor(beat / BAR) * BAR;
    if (((beat - bar) * 60) / c.clock.getBpm() > GRACE) bar += BAR;
    return { beat: bar, frame: Math.round((c.clock.timeAtBeat(bar, BAR) - c.k + MASTER_DELAY) * c.sr) };
  }

  // ── recording ──

  /** ●: arm; again, end on the next bar line; again (while ending), end now. */
  toggle(): void {
    if (!this.tap.running) return this.hooks.problem(this.tap.error ?? 'recording starts with the audio');
    const r = this.rec;
    if (!r) this.arm();
    else if (r.phase === 'armed') this.cancel();
    else if (r.phase === 'recording') this.endAtBar();
    else if (r.phase === 'finishing') this.endNow();
    this.hooks.changed();
  }

  private arm() {
    const bar = this.barLine();
    const c = this.clock();
    if (!bar || !c) return;
    this.rec = { phase: 'armed', startFrame: bar.frame, startBeat: bar.beat, endFrame: null, endBeat: null, bpm: c.clock.getBpm(), take: null, written: 0 };
    this.applyPause();
    this.pump();
  }

  private endAtBar() {
    const r = this.rec!;
    const bar = this.barLine();
    if (!bar) return;
    // Pressed again on the bar line it started on: never mind.
    if (bar.frame <= r.startFrame) return this.cancel();
    r.endFrame = bar.frame;
    r.endBeat = bar.beat;
    r.phase = 'finishing';
    this.pump();
  }

  /** End now, off the grid (⌘. stops the sound; `extra` keeps its fade-out). */
  endNow(extra = 0): void {
    const r = this.rec;
    if (!r || r.phase === 'saving') return;
    const c = this.clock();
    if (r.phase === 'armed' || !c) return this.cancel();
    const now = Math.round((this.heard(c.ctx) + extra) * c.sr);
    if (r.endFrame === null || now < r.endFrame) {
      r.endFrame = Math.max(r.startFrame + 1, now);
      r.endBeat = null;
    }
    r.phase = 'finishing';
    this.pump();
    this.hooks.changed();
  }

  private cancel() {
    const r = this.rec;
    this.rec = null;
    const t = r?.take;
    if (t) {
      this.takes = this.takes.filter((x) => x !== t);
      this.writes = this.writes.then(() => this.store.remove(t));
    }
    this.applyPause();
    this.hooks.changed();
  }

  /** Move what the ring has of the recording into its take (every couple of seconds). */
  private pump() {
    const r = this.rec;
    if (!r || r.phase === 'saving') return;
    const end = this.tap.end;
    if (r.phase === 'armed') {
      if (end <= r.startFrame) return;
      r.phase = 'recording';
      const take = this.newTake('recording');
      r.take = take;
      this.peaks = new Peaks(Math.round(PEAK_SECONDS * this.tap.sampleRate));
      this.part = 0;
      this.takes = [take, ...this.takes];
      this.writes = this.writes.then(() => this.store.put(take));
      this.hooks.changed();
    }
    const upTo = Math.min(end, r.endFrame ?? Infinity);
    const from = r.startFrame + r.written;
    const ending = r.endFrame !== null && upTo >= r.endFrame;
    if (upTo > from && (ending || upTo - from >= PART_SECONDS * this.tap.sampleRate)) this.write(r, this.tap.read(from, upTo), upTo - from);
    if (ending && r.startFrame + r.written >= r.endFrame!) this.finish(r);
  }

  private write(r: Recording, data: Float32Array, frames: number) {
    const take = r.take!;
    this.peaks!.push(data, frames);
    take.peaks = this.peaks!.result();
    r.written += frames;
    take.frames = r.written;
    const index = this.part++;
    const bytes = pcm24(data, frames * 2);
    this.writes = this.writes.then(async () => {
      await this.store.putPart(take, index, bytes);
      take.updated = Date.now();
      await this.store.put(take);
    });
  }

  private finish(r: Recording) {
    r.phase = 'saving';
    const take = r.take!;
    take.frames = Math.min(r.written, r.endFrame! - r.startFrame);
    if (r.endBeat !== null) {
      take.bars = Math.round((r.endBeat - r.startBeat) / BAR);
      take.bpm = r.bpm;
    }
    take.open = false;
    this.hooks.changed();
    this.writes = this.writes.then(async () => {
      take.updated = Date.now();
      await this.store.put(take);
      if (this.rec === r) this.rec = null;
      this.applyPause();
      this.hooks.changed();
      this.hooks.finished(take);
    });
  }

  // ── capture ──

  /** ⟲: the last N minutes of the mix (without the silence at either end) as a take. */
  async capture(): Promise<Take | null> {
    if (this.capturing) return null;
    if (!this.tap.running) {
      this.hooks.problem(this.tap.error ?? 'capture starts with the audio');
      return null;
    }
    this.capturing = true;
    this.hooks.changed();
    try {
      await this.tap.flush();
      const sr = this.tap.sampleRate;
      const want = Math.min(this.tap.held, Math.round(this.minutes * 60 * sr));
      const data = this.tap.copyLast(want);
      const loud = (i: number) => Math.abs(data[2 * i]) > SILENCE || Math.abs(data[2 * i + 1]) > SILENCE;
      let a = 0;
      let b = want;
      while (a < b && !loud(a)) a++;
      while (b > a && !loud(b - 1)) b--;
      if (b - a < sr / 4) {
        this.hooks.problem(want ? `nothing to capture: the last ${formatTime(want / sr)} were silent` : 'nothing to capture yet');
        return null;
      }
      const pad = Math.round(0.05 * sr);
      a = Math.max(0, a - pad);
      b = Math.min(want, b + pad);
      const take = this.newTake('capture');
      take.frames = b - a;
      const peaks = new Peaks(Math.round(PEAK_SECONDS * sr));
      const part = 5 * PART_SECONDS * sr;
      for (let f = a, i = 0; f < b; f += part, i++) {
        const n = Math.min(part, b - f);
        const slice = data.subarray(2 * f, 2 * (f + n));
        peaks.push(slice, n);
        await this.store.putPart(take, i, pcm24(slice));
      }
      take.peaks = peaks.result();
      take.open = false;
      await this.store.put(take);
      this.takes = [take, ...this.takes];
      this.hooks.finished(take);
      return take;
    } finally {
      this.capturing = false;
      this.hooks.changed();
    }
  }

  // ── takes ──

  /** Resolves once everything written so far is stored. */
  settled(): Promise<void> {
    return this.writes;
  }

  async wav(take: Take): Promise<Blob> {
    return takeWav(take, await this.store.parts(take));
  }

  async remove(take: Take): Promise<void> {
    if (this.rec?.take === take) return;
    this.takes = this.takes.filter((t) => t !== take);
    this.hooks.changed();
    await this.store.remove(take);
  }

  async rename(take: Take, name: string): Promise<void> {
    const n = name.trim();
    if (!n || n === take.name) return;
    take.name = n.slice(0, 80);
    this.hooks.changed();
    await this.store.put(take);
  }

  private newTake(kind: Take['kind']): Take {
    const word = kind === 'recording' ? 'take' : 'capture';
    const used = this.takes.map((t) => new RegExp(`^${word} (\\d+)`).exec(t.name)).map((m) => (m ? Number(m[1]) : 0));
    const now = Date.now();
    return {
      id: crypto.randomUUID(),
      kind,
      name: `${word} ${Math.max(0, ...used) + 1}`,
      created: now,
      updated: now,
      sampleRate: this.tap.sampleRate,
      channels: 2,
      frames: 0,
      patch: this.hooks.patchTitle(),
      peaks: new Float32Array(0),
      open: true,
    };
  }

  /** The takes this browser kept; one still open after a while is one the page closed on. */
  private async load() {
    const stored = await this.store.list();
    for (const t of stored) {
      if (!t.open || Date.now() - (t.updated ?? 0) < 15_000) continue;
      t.open = false;
      t.name = `${t.name} (recovered)`;
      await this.store.put(t);
    }
    const mine = new Set(this.takes.map((t) => t.id));
    this.takes = [...this.takes, ...stored.filter((t) => !mine.has(t.id))].sort((a, b) => b.created - a.created);
    this.hooks.changed();
  }

  private applyPause() {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    if (!(this.stopped && !this.rec)) {
      this.tap.paused = false;
      return;
    }
    // After the master's fade-out, so the ring keeps its tail.
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      this.tap.paused = this.stopped && !this.rec;
    }, 300);
  }
}
