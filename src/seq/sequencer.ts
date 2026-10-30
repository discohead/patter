// Routines: generator functions that play the patch, sclang-style.
//
// A routine's code is the body of a generator; `yield n` waits n beats.
// Everything it plays is stamped with its logical beat (converted through
// clockwork's session clock) and sent ahead as a timed bundle, so timing is
// the engine's, not the page's. Replacing a routine's code swaps it on its
// quant boundary, like Pdef/Tdef.

import type { OscBundlePacket } from 'supersonic-scsynth';
import type { Engine } from '../engine/engine';
import type { Runtime } from '../runtime/runtime';
import { compileBody, LoopGuard } from '../sc/dsl';
import { patternHelpers } from './helpers';

type Msg = [string, ...(string | number)[]];

interface Routine {
  name: string;
  code: string;
  quant: number;
  gen: Generator<unknown, unknown, unknown> | null;
  nextBeat: number;
  playing: boolean;
  /** A replacement waiting for its quant boundary. */
  pending: { code: string; gen: Generator<unknown, unknown, unknown>; startBeat: number } | null;
  error: string | null;
  events: number;
}

export interface RoutineStatus {
  name: string;
  playing: boolean;
  quant: number;
  nextBeat: number;
  error: string | null;
  events: number;
  pending: boolean;
}

const QUANTUM = 4;

export class Sequencer {
  private routines = new Map<string, Routine>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: { routine: Routine; beat: number; out: { time: number; msgs: Msg[] }[] } | null = null;
  private guard = new LoopGuard(100_000);
  private listeners = new Set<() => void>();
  readonly lookahead = 0.15;
  private logFn: (text: string) => void = () => {};
  /** Knobs and macros routines have turned ('filter.cutoff', 'macro:dark'), and when. */
  private turnedAt = new Map<string, number>();

  constructor(private readonly runtime: Runtime, private readonly engine: Engine) {}

  /** What routines have turned lately: a listener keeps its own values for these, since its routines turn them too. */
  turning(withinMs = 4000): Set<string> {
    const now = Date.now();
    return new Set([...this.turnedAt].filter(([, at]) => now - at < withinMs).map(([key]) => key));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onLog(fn: (text: string) => void) {
    this.logFn = fn;
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 20);
  }

  stopClock(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── clock ────────────────────────────────────────────────────────────────

  get bpm(): number {
    return this.engine.sonic.clock?.getBpm() ?? 120;
  }

  setBpm(bpm: number): void {
    if (!(bpm >= 10 && bpm <= 999)) throw new Error('bpm must be between 10 and 999');
    this.engine.sonic.clock?.setBpm(bpm);
    this.runtime.doc.bpm = bpm;
    // A new tempo re-anchors the beat; measure the engine's clock again.
    if (this.engine.booted) setTimeout(() => void this.engine.calibrateClock(), 50);
    this.changed();
  }

  beatNow(): number {
    const clock = this.engine.sonic.clock;
    if (!clock) return 0;
    return clock.beatAtTime(clock.now(), QUANTUM);
  }

  private timeAtBeat(beat: number): number {
    const clock = this.engine.sonic.clock!;
    return clock.timeAtBeat(beat, QUANTUM);
  }

  // ── routines ─────────────────────────────────────────────────────────────

  /** Define (or replace) a routine. Syntax errors throw now; runtime errors stop it later. */
  define(name: string, code: string, opts: { quant?: number; play?: boolean } = {}): RoutineStatus {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) throw new Error(`routine names are lowercase identifiers: '${name}'`);
    const quant = opts.quant ?? this.routines.get(name)?.quant ?? 4;
    if (!(quant >= 0)) throw new Error('quant must be ≥ 0 beats');
    const gen = this.instantiate(name, code);
    const play = opts.play ?? true;
    const now = this.beatNow();
    const startBeat = quant > 0 ? Math.ceil((now + 0.05) / quant) * quant : now + 0.05;
    const existing = this.routines.get(name);
    if (existing && existing.playing && play) {
      existing.pending = { code, gen, startBeat };
      existing.quant = quant;
    } else {
      this.routines.set(name, {
        name, code, quant, gen, nextBeat: startBeat, playing: play, pending: null, error: null, events: 0,
      });
    }
    this.runtime.doc.routines[name] = { code, playing: play, quant, description: this.runtime.doc.routines[name]?.description };
    this.changed();
    return this.status(name)!;
  }

  private instantiate(name: string, code: string): Generator<unknown, unknown, unknown> {
    const scope = this.scope(name);
    const fn = compileBody(code, Object.keys(scope), { operators: false, loopGuard: true, autoReturn: false, generator: true, lineMarkers: true });
    const genFn = fn.run(scope) as () => Generator<unknown, unknown, unknown>;
    return genFn();
  }

  play(name: string): void {
    const r = this.routines.get(name);
    if (!r) throw new Error(`no routine '${name}'`);
    if (r.playing) return;
    r.gen = this.instantiate(name, r.code);
    const now = this.beatNow();
    r.nextBeat = r.quant > 0 ? Math.ceil((now + 0.05) / r.quant) * r.quant : now + 0.05;
    r.playing = true;
    r.error = null;
    this.runtime.doc.routines[name].playing = true;
    this.changed();
  }

  stop(name: string): void {
    const r = this.routines.get(name);
    if (!r) throw new Error(`no routine '${name}'`);
    r.playing = false;
    r.pending = null;
    if (this.runtime.doc.routines[name]) this.runtime.doc.routines[name].playing = false;
    this.changed();
  }

  remove(name: string): void {
    this.routines.delete(name);
    delete this.runtime.doc.routines[name];
    this.changed();
  }

  stopAll(): void {
    for (const r of this.routines.values()) {
      r.playing = false;
      r.pending = null;
      if (this.runtime.doc.routines[r.name]) this.runtime.doc.routines[r.name].playing = false;
    }
    this.changed();
  }

  clear(): void {
    this.routines.clear();
    this.changed();
  }

  status(name: string): RoutineStatus | undefined {
    const r = this.routines.get(name);
    if (!r) return undefined;
    return { name, playing: r.playing, quant: r.quant, nextBeat: r.nextBeat, error: r.error, events: r.events, pending: Boolean(r.pending) };
  }

  list(): RoutineStatus[] {
    return [...this.routines.keys()].map((n) => this.status(n)!);
  }

  /**
   * Bring the routines to a document's, changing only what differs: new or
   * rewritten code is defined (a playing one swaps on its quant), one that
   * only started or stopped starts or stops, and the ones that are gone go.
   * The rest keep their place in the bar (a listener follows the host this way).
   */
  follow(routines: Record<string, { code: string; playing: boolean; quant: number; description?: string }>): string[] {
    const errors: string[] = [];
    for (const name of [...this.routines.keys()]) if (!routines[name]) this.remove(name);
    for (const [name, r] of Object.entries(routines)) {
      const current = this.routines.get(name);
      try {
        if (!current || (current.pending?.code ?? current.code) !== r.code || current.quant !== r.quant) this.define(name, r.code, { quant: r.quant, play: r.playing });
        else if (current.playing !== r.playing) {
          if (r.playing) this.play(name);
          else this.stop(name);
        }
      } catch (e) {
        errors.push(`routine ${name}: ${(e as Error).message}`);
        continue;
      }
      const d = this.runtime.doc.routines[name];
      if (d && r.description !== undefined) d.description = r.description;
      else if (d) delete d.description;
    }
    return errors;
  }

  /** Recreate routines from a document (after loading a patch). */
  load(routines: Record<string, { code: string; playing: boolean; quant: number }>): string[] {
    this.routines.clear();
    const errors: string[] = [];
    for (const [name, r] of Object.entries(routines)) {
      try {
        this.define(name, r.code, { quant: r.quant, play: r.playing });
      } catch (e) {
        errors.push(`routine ${name}: ${(e as Error).message}`);
      }
    }
    return errors;
  }

  // ── the scheduler ────────────────────────────────────────────────────────

  private tick() {
    const clock = this.engine.sonic.clock;
    if (!clock || !this.engine.booted) return;
    const horizon = clock.beatAtTime(clock.now() + this.lookahead, QUANTUM);
    let dirty = false;
    for (const r of this.routines.values()) {
      if (r.pending && r.pending.startBeat <= horizon) {
        r.code = r.pending.code;
        r.gen = r.pending.gen;
        r.nextBeat = r.pending.startBeat;
        r.pending = null;
        r.error = null;
        dirty = true;
      }
      let steps = 0;
      while (r.playing && r.gen && r.nextBeat <= horizon) {
        if (++steps > 2000) {
          this.fail(r, 'the routine scheduled more than 2000 steps in one tick — are the waits tiny?');
          break;
        }
        const out: { time: number; msgs: Msg[] }[] = [];
        this.current = { routine: r, beat: r.nextBeat, out };
        this.guard.count = 0;
        let res: IteratorResult<unknown, unknown>;
        try {
          res = r.gen.next();
        } catch (e) {
          this.current = null;
          this.fail(r, (e as Error).message);
          dirty = true;
          break;
        }
        this.current = null;
        this.flush(out);
        if (res.done) {
          r.playing = false;
          if (this.runtime.doc.routines[r.name]) this.runtime.doc.routines[r.name].playing = false;
          dirty = true;
          break;
        }
        const wait = res.value;
        if (typeof wait !== 'number' || !(wait > 0) || !Number.isFinite(wait)) {
          this.fail(r, `yield a positive number of beats (got ${String(wait)})`);
          dirty = true;
          break;
        }
        r.nextBeat += wait;
      }
    }
    if (dirty) this.changed();
  }

  private fail(r: Routine, message: string) {
    r.playing = false;
    r.error = message;
    if (this.runtime.doc.routines[r.name]) this.runtime.doc.routines[r.name].playing = false;
    this.logFn(`routine '${r.name}' stopped: ${message}`);
  }

  private flush(out: { time: number; msgs: Msg[] }[]) {
    // Group by time: one bundle per instant.
    const byTime = new Map<number, Msg[]>();
    for (const e of out) {
      const list = byTime.get(e.time) ?? [];
      list.push(...e.msgs);
      byTime.set(e.time, list);
    }
    for (const [time, msgs] of byTime) {
      this.engine.bundle(time, msgs as OscBundlePacket[]);
    }
  }

  private emit(msgs: Msg[], beatOffset = 0) {
    const c = this.current;
    if (!c) throw new Error('play()/set() can only be called while a routine runs');
    c.out.push({ time: this.timeAtBeat(c.beat + beatOffset), msgs });
    c.routine.events++;
  }

  // ── what routine code can call ───────────────────────────────────────────

  private scope(name: string): Record<string, unknown> {
    const rt = this.runtime;
    const self = this;
    const beat = () => self.current?.beat ?? self.beatNow();
    return {
      ...patternHelpers(),
      $guard: this.guard.guard,
      $at: () => {},
      /** Start a voice: play('bass', { note: 36, dur: 0.5, cutoff: 800 }). */
      play(ref: string, args: Record<string, number> = {}) {
        const module = rt.moduleFor(ref);
        const { dur = 1, legato = 0.8, note, ...rest } = args as Record<string, number>;
        const params: Record<string, number> = { ...rest };
        if (note !== undefined) {
          if (rt.hasParam(module, 'note')) params.note = note;
          else if (!('freq' in params)) params.freq = 440 * 2 ** ((note - 69) / 12);
        }
        const { id, msgs } = rt.voiceMessages(module, params);
        self.emit(msgs);
        if (rt.hasParam(module, 'gate') && !('gate' in rest && rest.gate === 0)) {
          self.emit([['/n_set', id, 'gate', 0]], dur * legato);
        }
        return id;
      },
      /** Set controls of a running module at this moment: set('lead', { t_gate: 1, freq: 220 }). */
      set(ref: string, args: Record<string, number>) {
        const node = rt.nodeOf(rt.moduleFor(ref));
        if (node === null) throw new Error(`no module '${ref}'`);
        const pairs = Object.entries(args).flat() as (string | number)[];
        self.emit([['/n_set', node, ...pairs]]);
      },
      /** Move a knob (the document follows): knob('filter.cutoff', 900). */
      knob(ref: string, value: number) {
        const r = rt.resolveParamRef(ref); // fails now, inside the routine, if the ref is wrong
        // The knob moves when the bundle plays, not when it is scheduled.
        const delay = Math.max(0, (self.timeAtBeat(beat()) - self.engine.now()) * 1000);
        self.turnedAt.set('macro' in r ? `macro:${r.macro}` : `${r.module}.${r.param}`, Date.now());
        setTimeout(() => ('macro' in r ? rt.setMacro(r.macro, value) : rt.setParam(r.module, r.param, value)), delay);
      },
      macro(name: string, value: number) {
        const delay = Math.max(0, (self.timeAtBeat(beat()) - self.engine.now()) * 1000);
        self.turnedAt.set(`macro:${name}`, Date.now());
        setTimeout(() => rt.setMacro(name, value), delay);
      },
      beat,
      bar: () => Math.floor(beat() / 4),
      bpm: () => self.bpm,
      log: (...a: unknown[]) => self.logFn(`[${name}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`),
    };
  }
}
