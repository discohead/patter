// The names DSL code can use: every UGen class in the catalog (as callable
// objects with .ar/.kr/.ir/.new), the hand-built ones, Env, and helpers.

import catalogJson from './ugen-catalog.json';
import { makeUGenClass, type Catalog, type UGenSpec } from './catalog';
import { $bin, $call, $un } from './dsl';
import { Env } from './env';
import { mix, setSignalRanges } from './methods';
import { SPECIAL_CLASSES } from './special';
import { SAMPLER_CLASSES } from './samplers';
import { GraphError, Sig, bin, madd, un, type SigLike } from './ugen';
import { UNARY_OPS, type UnaryOp } from './ops';
import { Prewrite } from '../seq/prewrite';

export const catalog = catalogJson as unknown as Catalog;

setSignalRanges(Object.values(catalog.ugens).map((u) => [u.serverName, u.signalRange] as [string, 'bipolar' | 'unipolar' | undefined]));

type AnyFn = (...a: unknown[]) => unknown;

function callable(name: string, spec: UGenSpec): AnyFn & Record<string, AnyFn> {
  const methods = makeUGenClass(name, spec);
  const direct = methods.new ?? methods.ar ?? methods.kr ?? methods.ir;
  const f = ((...a: unknown[]) => {
    if (!direct) throw new GraphError(`${name} has no constructor`);
    return direct(...a);
  }) as AnyFn & Record<string, AnyFn>;
  Object.assign(f, methods);
  return f;
}

/** UGen classes by sclang class name. */
export const ugenClasses: Record<string, AnyFn & Record<string, AnyFn>> = {};
for (const [name, spec] of Object.entries(catalog.ugens)) {
  if (spec.internal) continue;
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) continue;
  ugenClasses[name] = callable(name, spec);
}
Object.assign(ugenClasses, SPECIAL_CLASSES, SAMPLER_CLASSES);

/** Reference text for the sample players (they are patter's, not sclang's). */
const SAMPLER_DOCS: Record<string, string> = {
  BeatPhase:
    "BeatPhase.ar(quantum=4) / BeatPhase.kr(quantum=4) — the transport's beat position in [0, quantum), on the same beat grid routines play on; .ar is sample-accurate. Lock anything to the beat: a BufRd position, an LFO's phase, a clock (Changed.kr(BeatPhase.kr(4).floor())). Use a quantum that divides 768.",
  LinkPhase:
    "LinkPhase.kr(quantum=4) — the session's beat phase in [0, quantum), corrected onto the beat grid routines play on (the same as BeatPhase.kr). Use a quantum that divides 768.",
  OneShot:
    "OneShot.ar(sample, { rate=1, pitch (semitones), note (MIDI, relative to the sample's root), start=0 (0..1 of its length), reverse=0, trig=1, loop=0, amp=1 }) — plays a sample once. In a voice module it ends the voice when it finishes; in a persistent module a new trigger on trig plays it again. Its channels are the sample's.",
  Slice:
    "Slice.ar(sample, { index=0, slices=16, rate=1, pitch (semitones), reverse=0, trig=1, amp=1 }) — one of `slices` equal parts of the sample, with 2 ms edges. In a voice it ends the voice at the slice's end; in a persistent module a trigger on trig plays it again. 16 slices of a 4-beat loop are its 16ths.",
  Grains:
    "Grains.ar(sample, { position=0.5 (0..1), spray=0.05, density=20 (grains a second), size=0.12 (seconds), pitch=0, pitchSpray=0 (semitones), pan=0, spread=0.5, sync=false (grains on a steady pulse instead of at random), voices=8 (grains at once), amp=0.5 }) — a stereo grain cloud from any sample, mono or stereo.",
  QLoop:
    "QLoop.ar(sample, { start=0, length=4, rate=1, reverse=0, pitch=0, scale, period=12, quant=1, grid=0.25, mode='tape', retrigger=false, window=0.1, overlaps=4, jitter=0.05, beats, amp=1 }) — the fully quantized looping buffer. Plays the sample's beats locked to the transport, at any tempo. Each setting is quantized in value — start (beats into the sample) to the grid, length (beats) to powers of two up to the sample's length, rate to quarter steps (0 = freeze), reverse on/off, pitch to scale degrees (scale: steps in semitones, fractions for microtonal, repeating every period) — and in time: changes land on the next quant boundary (beats). Every combination is a seamless loop in time. mode 'tape' reads the buffer (rate is the pitch: 0.5 is an octave down); 'stretch' granulates it (Warp1: pitch and time apart; rate 0 holds a frozen cloud). By default the loop is locked to the transport (a setting always plays the same audio at the same bar); retrigger: true restarts it from its start when a setting changes. Needs the sample's beats (the samples tool sets them).",
};

// Env.kr / Env.ar (sclang 3.10+): env.kr(doneAction, gate, timeScale, mul, add)
Object.assign(Env.prototype, {
  kr(this: Env, doneAction: SigLike = 0, gate: SigLike = 1, timeScale: SigLike = 1, mul: SigLike = 1, add: SigLike = 0) {
    return madd(ugenClasses.EnvGen.kr(this, gate, 1, 0, timeScale, doneAction) as SigLike, mul, add);
  },
  ar(this: Env, doneAction: SigLike = 0, gate: SigLike = 1, timeScale: SigLike = 1, mul: SigLike = 1, add: SigLike = 0) {
    return madd(ugenClasses.EnvGen.ar(this, gate, 1, 0, timeScale, doneAction) as SigLike, mul, add);
  },
});

const num = (x: unknown) => typeof x === 'number';

/** Free functions (sclang's `rrand(a, b)`, `midicps(x)`, …). */
const helpers: Record<string, unknown> = {
  inf: Infinity,
  pi: Math.PI,
  twopi: Math.PI * 2,
  Env,
  fill: (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i)),
  dup: (x: unknown, n = 2) => Array.from({ length: n }, (_, i) => (typeof x === 'function' ? (x as AnyFn)(i) : x)),
  sum: (a: SigLike) => mix(a),
  rrand: (lo: number, hi: number) => (Number.isInteger(lo) && Number.isInteger(hi) ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo + Math.random() * (hi - lo)),
  exprand: (lo: number, hi: number) => lo * Math.exp(Math.log(hi / lo) * Math.random()),
  rand: (x = 1) => Math.random() * x,
  rand2: (x = 1) => (Math.random() * 2 - 1) * x,
  coin: (p = 0.5) => Math.random() < p,
  choose: (a: unknown[]) => a[Math.floor(Math.random() * a.length)],
  // build-time L-systems: Dseq(Prewrite(0, { 0: [0, 1], 1: [1, 0] }, 8).nextN(256), inf)
  Prewrite,
  max: (a: SigLike, b: SigLike) => (num(a) && num(b) ? Math.max(a as number, b as number) : bin('max', a, b)),
  min: (a: SigLike, b: SigLike) => (num(a) && num(b) ? Math.min(a as number, b as number) : bin('min', a, b)),
  pow: (a: SigLike, b: SigLike) => bin('pow', a, b),
  clip: (x: SigLike, lo: SigLike = -1, hi: SigLike = 1) => (x instanceof Sig ? x.clip(lo, hi) : $call(x, 'clip', [lo, hi])),
  // the circle of SC conveniences
  Sig,
  $bin, $un, $call,
};

for (const op of Object.keys(UNARY_OPS) as UnaryOp[]) {
  if (!(op in helpers)) helpers[op] = (x: SigLike) => un(op, x);
}

export function baseScope(): Record<string, unknown> {
  return { ...ugenClasses, ...helpers };
}

/** Short reference text for one UGen (shown to the agent on request). */
export function describeUGen(name: string): string | null {
  if (SAMPLER_DOCS[name]) return SAMPLER_DOCS[name];
  const spec = catalog.ugens[name];
  if (!spec) return SPECIAL_CLASSES[name] ? `${name}: built from other UGens (see the patch-language guide)` : null;
  const lines = [`${name} — ${spec.summary ?? ''}`.trim()];
  for (const [m, ms] of Object.entries(spec.methods)) {
    if (!ms) continue;
    const args = ms.args.map((a) => (a.default === null || a.default === undefined ? a.name : `${a.name}=${JSON.stringify(a.default)}`));
    if (ms.mulAdd) args.push('mul=1', 'add=0');
    const outs = typeof ms.numOutputs === 'number' ? (ms.numOutputs === 1 ? '' : ` → ${ms.numOutputs} outputs`) : ` → outputs from ${JSON.stringify(ms.numOutputs)}`;
    lines.push(`  ${name}.${m}(${args.join(', ')})${outs}`);
  }
  if (spec.argDocs) {
    for (const [k, v] of Object.entries(spec.argDocs)) lines.push(`    ${k}: ${v}`);
  }
  if (spec.signalRange === 'unipolar') lines.push('  output range: unipolar (0..1)');
  return lines.join('\n');
}
