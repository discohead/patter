// Sample playback for the patch language: OneShot for hits, QLoop for loops
// that stay in time whatever you do to them, and BeatPhase, the transport's
// position at audio rate that keeps them there. Built from scsynth's buffer
// UGens and the session clock (LinkPhase/LinkTempo, which run at control rate).

import { raw, toRate } from './methods';
import { Changed, cls, sig } from './special';
import { GraphBuilder, GraphError, Sig, bin, builder, describe, madd, un, type SigLike } from './ugen';

/** The kind of module being compiled (voices free themselves when a one-shot ends). */
export const moduleKind = new WeakMap<GraphBuilder, string>();

/**
 * The session clock, as routines see it. LinkPhase reads the engine's beat,
 * which SuperSonic 0.91 can put a constant offset away from the beat grid the
 * client schedules on (see Engine.calibrateClock). The runtime measures that
 * offset and keeps it, in beats modulo CLOCK_PERIOD, on control bus CLOCK_BUS;
 * everything here subtracts it. CLOCK_PERIOD is 3 × 256, so every quantum
 * dividing it (powers of two up to 256, and triplet cycles) stays exact.
 */
export const CLOCK_BUS = 1;
export const CLOCK_PERIOD = 768;

/** The corrected beat phase within [0, quantum), once a block (quantum must divide CLOCK_PERIOD). */
function sessionPhase(quantum: SigLike): SigLike {
  const k = raw('Wrap', 'control', [bin('-', raw('LinkPhase', 'control', [CLOCK_PERIOD]), raw('In', 'control', [CLOCK_BUS])), 0, CLOCK_PERIOD]);
  return quantum === CLOCK_PERIOD ? k : raw('Wrap', 'control', [k, 0, quantum]);
}

function checkQuantum(label: string, q: SigLike): void {
  if (typeof q === 'number' && (!(q > 0) || CLOCK_PERIOD % q !== 0)) {
    builder().warn(`${label}(${q}): use a quantum that divides ${CLOCK_PERIOD} (1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 768) to stay exactly in time with routines`);
  }
}

/**
 * What sample('name') returns: the buffer number as a signal (it goes
 * wherever a bufnum does: PlayBuf.ar(s.channels, s)), carrying what a sampler
 * needs. beats and root are controls, so they follow when another sample is
 * put under the same name.
 */
export interface SampleHandle extends Sig {
  readonly sampleName: string;
  readonly channels: number;
  readonly beats: Sig;
  readonly root: Sig;
  /** As the sample is now (for messages and defaults; the controls are what plays). */
  readonly info: { frames: number; duration: number; beats?: number; root?: number };
}

/** The control's own Sig, given the handle's fields (the SynthDef finisher rewires control Sigs in place, so it must be that object). */
export function makeSampleHandle(buf: Sig, fields: Omit<SampleHandle, keyof Sig>): SampleHandle {
  return Object.assign(buf, fields) as SampleHandle;
}

function isSampleHandle(x: unknown): x is SampleHandle {
  return x instanceof Sig && typeof (x as Partial<SampleHandle>).channels === 'number' && (x as Partial<SampleHandle>).beats instanceof Sig;
}

function needSample(label: string, x: unknown): SampleHandle {
  if (isSampleHandle(x)) return x;
  throw new GraphError(`${label}: the first argument is a sample, from sample('name') (got ${describe(x)})`);
}

/** A control the runtime fills in (one per graph). */
function internalControl(name: string, dflt: number): Sig {
  const g = builder();
  return g.controls.find((c) => c.name === name)?.sigs[0] ?? g.control(name, 'control', [dflt])[0];
}

const kr = (x: SigLike) => toRate(x, 'control') as SigLike;

/** SendReply, spelled out (its command name travels as character codes). */
function sendReply(trig: SigLike, cmd: string, values: SigLike[], replyID: SigLike): void {
  raw('SendReply', 'control', [trig, replyID, cmd.length, ...[...cmd].map((c) => c.charCodeAt(0)), ...values], 0, { sideEffect: true });
}

// ── BeatPhase ───────────────────────────────────────────────────────────────

/**
 * The transport's beat position in [0, quantum), at audio rate. LinkPhase
 * reports it exactly once a block (computed in double precision); a Phasor
 * carries it between blocks at the session tempo and is set back to the
 * clock on every beat, so it follows tempo changes and never drifts.
 */
export function beatPhase(quantum: SigLike = 4): SigLike {
  const k = sessionPhase(quantum);
  const bps = raw('LinkTempo', 'control', [0, 1]);
  const resync = bin('+', Changed.kr(un('floor', k)), raw('Impulse', 'control', [0, 0]));
  return raw('Phasor', 'audio', [resync, bin('*', bps, raw('SampleDur', 'scalar', [])), 0, quantum, k]);
}

export const BeatPhase = cls({
  ar: (quantum: unknown = 4) => {
    const q = sig('BeatPhase', 'quantum', quantum);
    checkQuantum('BeatPhase.ar', q);
    return beatPhase(q);
  },
  kr: (quantum: unknown = 4) => {
    const q = sig('BeatPhase', 'quantum', quantum);
    checkQuantum('BeatPhase.kr', q);
    return sessionPhase(q);
  },
});

/** LinkPhase.kr, corrected onto the beat grid routines use (patter's scope replaces sclang's). */
export const LinkPhase = cls({
  kr: (quantum: unknown = 4) => {
    const q = sig('LinkPhase', 'quantum', quantum);
    checkQuantum('LinkPhase.kr', q);
    return sessionPhase(q);
  },
});

// ── OneShot ─────────────────────────────────────────────────────────────────

type Opts = Record<string, unknown>;

function opt(label: string, o: Opts, name: string, dflt: SigLike): SigLike {
  return sig(label, name, o[name], dflt);
}

/**
 * A hit: the sample from `start` (0..1 of its length) at `rate`, transposed
 * by `pitch` semitones or played at `note` (relative to the sample's root),
 * backwards when `reverse`. In a voice it ends the voice when it finishes; in
 * a persistent module `trig` replays it.
 */
function oneShot(sIn: unknown, opts: unknown = {}): SigLike {
  const label = 'OneShot.ar';
  const s = needSample(label, sIn);
  const o = (opts ?? {}) as Opts;
  let rate = bin('*', opt(label, o, 'rate', 1), raw('BufRateScale', 'control', [s]));
  if (o.pitch !== undefined) rate = bin('*', rate, bin('pow', 2, bin('/', opt(label, o, 'pitch', 0), 12)));
  if (o.note !== undefined) rate = bin('*', rate, bin('pow', 2, bin('/', bin('-', opt(label, o, 'note', 60), s.root), 12)));
  const rev = bin('>', opt(label, o, 'reverse', 0), 0.5);
  const frames = raw('BufFrames', 'control', [s]);
  const start = opt(label, o, 'start', 0);
  const from = raw('Select', 'control', [rev, bin('*', start, frames), bin('-', bin('*', bin('-', 1, start), frames), 1)]);
  const done = moduleKind.get(builder()) === 'voice' ? 2 : 0;
  const out = raw(
    'PlayBuf',
    'audio',
    [s, bin('*', rate, bin('-', 1, bin('*', 2, rev))), opt(label, o, 'trig', 1), from, opt(label, o, 'loop', 0), done],
    s.channels,
    { sideEffect: done !== 0 },
  );
  return madd(out, opt(label, o, 'amp', 1), 0);
}

export const OneShot = cls({ ar: oneShot });

// ── QLoop: the fully quantized looping buffer ────────────────────────────────

/**
 * Positions wrap at CLOCK_PERIOD (768) beats: a multiple of every loop length
 * (powers of two up to 64) times every rate (quarter steps), so the loop is
 * seamless across the wrap, and small enough that a float holds the position
 * to about a sample.
 */
const PERIOD = CLOCK_PERIOD;

/**
 * Plays the sample's beats in time with the transport. Every parameter is
 * quantized twice: in value (start to the grid, length to powers of two,
 * rate to quarters, pitch to a scale) and in time (changes land on the next
 * `quant` boundary). By default the loop is locked to the transport — a
 * setting always plays the same audio at the same bar; `retrigger` restarts
 * it from its start whenever a setting changes. `mode` 'tape' reads the
 * buffer (rate is the pitch); 'stretch' granulates it (pitch and time apart).
 */
function qloop(sIn: unknown, opts: unknown = {}): SigLike {
  const label = 'QLoop.ar';
  const s = needSample(label, sIn);
  const o = (opts ?? {}) as Opts;
  const g = builder();
  const mode = o.mode === undefined ? 'tape' : o.mode;
  if (mode !== 'tape' && mode !== 'stretch') throw new GraphError(`${label}: mode is 'tape' or 'stretch'`);
  if (mode === 'tape' && o.pitch !== undefined) g.warn(`${label}: pitch needs mode: 'stretch' (in tape mode, rate is the pitch)`);
  const beats = o.beats === undefined ? s.beats : opt(label, o, 'beats', 4);
  const quant = opt(label, o, 'quant', 1);
  const grid = opt(label, o, 'grid', 0.25);

  // When changes may land: the start, then every `quant` beats of the transport.
  const k = sessionPhase(PERIOD);
  const tick = bin('+', Changed.kr(un('floor', bin('/', k, quant))), raw('Impulse', 'control', [0, 0]));
  const latch = (x: SigLike) => raw('Latch', 'control', [kr(x), tick]);

  // What they may land on.
  const start = raw('Clip', 'control', [bin('round', kr(opt(label, o, 'start', 0)), grid), 0, bin('max', bin('-', beats, grid), 0)]);
  const length = bin('min', bin('min', bin('pow', 2, bin('round', un('log2', bin('max', kr(opt(label, o, 'length', 4)), 0.25)), 1)), beats), 64);
  const rate = raw('Clip', 'control', [bin('round', kr(opt(label, o, 'rate', 1)), 0.25), 0, 8]);
  const reverse = bin('>', kr(opt(label, o, 'reverse', 0)), 0.5);
  const S = latch(start), L = latch(length), R = latch(rate), V = latch(reverse);

  const beat = beatPhase(PERIOD);
  let elapsed: SigLike = beat;
  if (o.retrigger) {
    // Restart from the start at the grid point where anything changed.
    const any = bin('+', bin('+', Changed.kr(S), Changed.kr(L)), bin('+', bin('+', Changed.kr(R), Changed.kr(V)), raw('Impulse', 'control', [0, 0])));
    const anchor = raw('Latch', 'control', [bin('round', k, quant), any]);
    elapsed = raw('Wrap', 'audio', [bin('-', beat, anchor), 0, PERIOD]);
  }
  const forward = raw('Wrap', 'audio', [bin('*', elapsed, R), 0, L]);
  const backward = raw('Wrap', 'audio', [bin('-', L, forward), 0, L]);
  const pos = bin('+', S, bin('+', forward, bin('*', V, bin('-', backward, forward))));
  const frames = raw('BufFrames', 'control', [s]);
  const frame = bin('*', pos, bin('/', frames, beats));

  let out: SigLike;
  if (mode === 'tape') out = declickedRead(s, s.channels, frame);
  else {
    let semis: SigLike = bin('round', kr(opt(label, o, 'pitch', 0)), 1);
    if (Array.isArray(o.scale)) {
      // Scale degrees: any steps in semitones (fractions for microtonal), any period.
      const steps = (o.scale as unknown[]).map((x, i) => sig(label, `scale[${i}]`, x));
      if (!steps.length) throw new GraphError(`${label}: scale needs at least one step`);
      const period = opt(label, o, 'period', 12);
      const idx = bin('%', semis, steps.length);
      const octave = un('floor', bin('/', semis, steps.length));
      semis = bin('+', steps.length === 1 ? steps[0] : raw('Select', 'control', [idx, ...steps]), bin('*', octave, period));
    }
    const freq = bin('pow', 2, bin('/', latch(semis), 12));
    out = raw(
      'Warp1',
      'audio',
      [s, bin('/', frame, frames), freq, opt(label, o, 'window', 0.1), -1, opt(label, o, 'overlaps', 4), opt(label, o, 'jitter', 0.05), 4],
      s.channels,
    );
  }

  // Where it is, for the waveform view (20 times a second).
  sendReply(raw('Impulse', 'control', [20, 0]), '/patter/playhead', [raw('A2K', 'control', [pos]), S, L, beats, V, R], internalControl('__pid', 0));
  return madd(out, opt(label, o, 'amp', 1), 0);
}

/**
 * BufRd that never clicks: whenever the position jumps (the loop's seam, a
 * quantized change) a second head carries on from where the first was and
 * the two crossfade over 8 ms.
 */
function declickedRead(buf: Sig, channels: number, frame: SigLike): SigLike {
  const prev = raw('Delay1', 'audio', [frame]);
  const jump = bin('>', un('abs', bin('-', frame, prev)), 64);
  const offset = raw('Latch', 'audio', [bin('-', prev, frame), jump]);
  const fade = bin('min', raw('Sweep', 'audio', [jump, 1 / 0.008]), 1);
  const now = raw('BufRd', 'audio', [buf, frame, 1, 4], channels);
  const before = raw('BufRd', 'audio', [buf, bin('+', frame, offset), 1, 4], channels);
  return bin('+', bin('*', now, fade), bin('*', before, bin('-', 1, fade)));
}

export const QLoop = cls({ ar: qloop });

// ── Slice ───────────────────────────────────────────────────────────────────

/**
 * One slice of a sample cut into `slices` equal parts (a beat-cut loop
 * chops into 16ths at slices: beats * 4): slice `index`, at `rate` /
 * `pitch`, backwards when `reverse`, with 2 ms edges so it never clicks.
 * In a voice it ends the voice at the slice's end; in a persistent module
 * `trig` plays it again.
 */
function slice(sIn: unknown, opts: unknown = {}): SigLike {
  const label = 'Slice.ar';
  const s = needSample(label, sIn);
  const o = (opts ?? {}) as Opts;
  const count = opt(label, o, 'slices', 16);
  const index = bin('%', un('floor', kr(opt(label, o, 'index', 0))), count);
  let rate: SigLike = kr(opt(label, o, 'rate', 1));
  if (o.pitch !== undefined) rate = bin('*', rate, bin('pow', 2, bin('/', kr(opt(label, o, 'pitch', 0)), 12)));
  const rev = bin('>', kr(opt(label, o, 'reverse', 0)), 0.5);
  const frames = raw('BufFrames', 'control', [s]);
  const length = bin('/', frames, count);
  const first = bin('*', index, length);
  const trig = opt(label, o, 'trig', 1);
  const speed = bin('*', bin('*', rate, raw('BufRateScale', 'control', [s])), raw('SampleRate', 'scalar', []));
  const along = raw('Sweep', 'audio', [trig, speed]);
  const offset = bin('+', bin('*', bin('-', 1, rev), along), bin('*', rev, bin('-', bin('-', length, 1), along)));
  const read = raw('BufRd', 'audio', [s, bin('+', first, offset), 0, 4], s.channels);
  // Duration of the slice at this rate, with 2 ms edges.
  const seconds = bin('/', length, bin('max', speed, 1e-6));
  const done = moduleKind.get(builder()) === 'voice' ? 2 : 0;
  const env = raw('EnvGen', 'audio', [trig, 1, 0, 1, done, 0, 3, -99, -99, 1, 0.002, 1, 0, 1, bin('max', bin('-', seconds, 0.004), 0), 1, 0, 0, 0.002, 1, 0], 1, { sideEffect: done !== 0 });
  return madd(bin('*', read, env), opt(label, o, 'amp', 1), 0);
}

export const Slice = cls({ ar: slice });

// ── Grains ──────────────────────────────────────────────────────────────────

/**
 * A grain cloud from any sample (stereo too: TGrains and GrainBuf read only
 * mono buffers, so this runs its own `voices` grain readers, round-robin).
 * position (0..1) and spray place grains in the sample; density is grains a
 * second (on the beat grid when sync); size their length in seconds; pitch
 * (semitones) and pitchSpray their transposition; pan and spread their place.
 */
function grains(sIn: unknown, opts: unknown = {}): SigLike {
  const label = 'Grains.ar';
  const s = needSample(label, sIn);
  const o = (opts ?? {}) as Opts;
  const voices = typeof o.voices === 'number' ? Math.max(1, Math.min(32, Math.round(o.voices))) : 8;
  const density = opt(label, o, 'density', 20);
  const trig = o.sync ? raw('Impulse', 'audio', [density, 0]) : raw('Dust', 'audio', [density]);
  const frames = raw('BufFrames', 'control', [s]);
  const size = kr(opt(label, o, 'size', 0.12));
  const rng = (t: SigLike) => raw('TRand', 'audio', [-1, 1, t]);
  const out: SigLike[] = [];
  for (let i = 0; i < voices; i++) {
    const t = raw('PulseDivider', 'audio', [trig, voices, i]);
    const where = bin('*', raw('Wrap', 'audio', [bin('+', opt(label, o, 'position', 0.5), bin('*', opt(label, o, 'spray', 0.05), rng(t))), 0, 1]), frames);
    const start = raw('Latch', 'audio', [where, t]);
    const semis = bin('+', opt(label, o, 'pitch', 0), bin('*', opt(label, o, 'pitchSpray', 0), rng(t)));
    const rate = raw('Latch', 'audio', [bin('pow', 2, bin('/', semis, 12)), t]);
    const along = raw('Sweep', 'audio', [t, bin('*', bin('*', rate, raw('BufRateScale', 'control', [s])), raw('SampleRate', 'scalar', []))]);
    const grain = raw('BufRd', 'audio', [s, bin('+', start, along), 1, 4], s.channels);
    // A sine window the grain's length.
    const env = raw('EnvGen', 'audio', [t, 1, 0, size, 0, 0, 2, -99, -99, 1, 0.5, 3, 0, 0, 0.5, 3, 0], 1);
    const pan = raw('Clip', 'audio', [bin('+', opt(label, o, 'pan', 0), bin('*', opt(label, o, 'spread', 0.5), rng(t))), -1, 1]);
    const g = bin('*', grain, env);
    out.push(s.channels === 1 ? raw('Pan2', 'audio', [g as Sig, pan, 1], 2) : s.channels === 2 ? raw('Balance2', 'audio', [(g as Sig[])[0], (g as Sig[])[1], pan, 1], 2) : g);
  }
  const sum = out.reduce((a, b) => bin('+', a, b));
  return madd(sum, bin('*', opt(label, o, 'amp', 0.5), 1 / Math.sqrt(Math.max(1, voices / 2))), 0);
}

export const Grains = cls({ ar: grains });

/** The engine's own beat phase, uncorrected (the clock calibration's probe reads it). */
const LinkPhaseRaw = cls({ kr: (quantum: unknown = 4) => raw('LinkPhase', 'control', [sig('LinkPhaseRaw', 'quantum', quantum)]) });

export const SAMPLER_CLASSES = { BeatPhase, Grains, LinkPhase, LinkPhaseRaw, OneShot, QLoop, Slice };
