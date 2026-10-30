// UGens whose sclang constructors transform their arguments in ways a plain
// input map can't express, and the pseudo-UGens sclang builds from others.
// Each follows the sclang 3.14 class-library source it names.

import { resolveArgs } from './catalog';
import { mix, raw, splay, toRate } from './methods';
import { GraphBuilder, GraphError, Sig, UGen, bin, builder, describe, expand, madd, rateOf, un, type Rate, type SigLike } from './ugen';

type Fn = (...a: unknown[]) => SigLike;
export type UGenClass = Fn & Record<string, Fn>;

const isNum = (x: unknown): x is number => typeof x === 'number';

export function cls(methods: Record<string, Fn>, direct?: Fn): UGenClass {
  const f = (direct ?? methods.new ?? methods.ar ?? methods.kr) as UGenClass;
  const out = ((...a: unknown[]) => f(...a)) as UGenClass;
  Object.assign(out, methods);
  return out;
}

export function sig(label: string, name: string, v: unknown, dflt?: SigLike): SigLike {
  if (v === undefined || v === null) {
    if (dflt !== undefined) return dflt;
    throw new GraphError(`${label}: argument '${name}' is required`);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isNum(v) || v instanceof Sig) return v;
  if (Array.isArray(v)) return v.map((x, i) => sig(label, `${name}[${i}]`, x));
  throw new GraphError(`${label}: '${name}' must be a signal, number or array, got ${describe(v)}`);
}

const list = (x: SigLike): SigLike[] => (Array.isArray(x) ? x : [x]);

function flop(rows: SigLike[][]): SigLike[][] {
  const n = Math.max(...rows.map((r) => r.length));
  return Array.from({ length: n }, (_, i) => rows.map((r) => r[i % r.length]));
}

function ugen(name: string, rate: Rate, inputs: (number | Sig)[], numOutputs: number, flags: { pure?: boolean; sideEffect?: boolean } = {}): SigLike {
  const u = new UGen(builder(), name, rate, inputs, numOutputs, 0, flags);
  return numOutputs === 0 ? 0 : numOutputs === 1 ? u.outputs[0] : [...u.outputs];
}

function expanded(inputs: unknown[], build: (ins: (number | Sig)[]) => SigLike): SigLike {
  return expand(inputs, (ins) => build(ins as (number | Sig)[])) as SigLike;
}

// ── Klank / Klang (Ref'd spec arrays) ───────────────────────────────────────

function specRows(label: string, specs: unknown, fills: number[]): SigLike[][] {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new GraphError(`${label}: first argument is [freqs, amps, times] (amps/times may be null)`);
  }
  const freqs = list(sig(label, 'freqs', specs[0]));
  return [freqs, ...fills.map((fill, i) => {
    const row = specs[i + 1];
    return row === null || row === undefined ? freqs.map(() => fill) : list(sig(label, 'spec', row));
  })];
}

export const Klank = cls({
  ar: (...a: unknown[]) => {
    const label = 'Klank.ar';
    const { vals } = resolveArgs(label, {
      args: [{ name: 'specificationsArrayRef', default: null }, { name: 'input', default: null }, { name: 'freqscale', default: 1 }, { name: 'freqoffset', default: 0 }, { name: 'decayscale', default: 1 }],
      mulAdd: false,
    }, a);
    const rows = specRows(label, vals.specificationsArrayRef, [1, 1]);
    const head = [toRate(sig(label, 'input', vals.input), 'audio'), sig(label, 'freqscale', vals.freqscale), sig(label, 'freqoffset', vals.freqoffset), sig(label, 'decayscale', vals.decayscale)];
    return expanded([...head, ...flop(rows).flat()], (ins) => ugen('Klank', 'audio', ins, 1, { pure: true }));
  },
});

export const Klang = cls({
  ar: (...a: unknown[]) => {
    const label = 'Klang.ar';
    const { vals } = resolveArgs(label, {
      args: [{ name: 'specificationsArrayRef', default: null }, { name: 'freqscale', default: 1 }, { name: 'freqoffset', default: 0 }],
      mulAdd: false,
    }, a);
    const rows = specRows(label, vals.specificationsArrayRef, [1, 0]);
    const head = [sig(label, 'freqscale', vals.freqscale), sig(label, 'freqoffset', vals.freqoffset)];
    return expanded([...head, ...flop(rows).flat()], (ins) => ugen('Klang', 'audio', ins, 1, { pure: true }));
  },
});

function dynKlank(rate: Rate): Fn {
  return (specs: unknown, input: unknown, freqscale: unknown = 1, freqoffset: unknown = 0, decayscale: unknown = 1) => {
    const label = 'DynKlank';
    if (!Array.isArray(specs)) throw new GraphError(`${label}: first argument is [freqs, amps, times]`);
    const freqs = bin('+', bin('*', sig(label, 'freqs', specs[0], [440]), sig(label, 'freqscale', freqscale)), sig(label, 'freqoffset', freqoffset));
    const times = bin('*', sig(label, 'times', specs[2], [1]), sig(label, 'decayscale', decayscale));
    const amps = sig(label, 'amps', specs[1], [1]);
    const ringz = raw('Ringz', rate, [rate === 'audio' ? toRate(sig(label, 'input', input), 'audio') : sig(label, 'input', input), freqs, times]);
    return mix(bin('*', ringz, amps));
  };
}
export const DynKlank = cls({ ar: dynKlank('audio'), kr: dynKlank('control') });

function dynKlang(rate: Rate): Fn {
  return (specs: unknown, freqscale: unknown = 1, freqoffset: unknown = 0) => {
    if (!Array.isArray(specs)) throw new GraphError('DynKlang: first argument is [freqs, amps, phases]');
    const freqs = bin('+', bin('*', sig('DynKlang', 'freqs', specs[0]), sig('DynKlang', 'freqscale', freqscale)), sig('DynKlang', 'freqoffset', freqoffset));
    const phases = sig('DynKlang', 'phases', specs[2], 0);
    const amps = sig('DynKlang', 'amps', specs[1], 1);
    return mix(bin('*', raw('SinOsc', rate, [freqs, phases]), amps));
  };
}
export const DynKlang = cls({ ar: dynKlang('audio'), kr: dynKlang('control') });

// ── LocalBuf (+ the MaxLocalBufs sclang adds) ──────────────────────────────────────────────────────

const maxLocalBufs = new WeakMap<object, UGen>();

/** A LocalBuf in graph `g`, counted in the MaxLocalBufs sclang adds once per SynthDef. */
export function localBuf(g: GraphBuilder, numFrames: number | Sig, numChannels: number | Sig = 1): Sig {
  let mlb = maxLocalBufs.get(g);
  if (!mlb) {
    mlb = new UGen(g, 'MaxLocalBufs', 'scalar', [0], 1, 0, { sideEffect: true });
    maxLocalBufs.set(g, mlb);
  }
  mlb.inputs[0] = (mlb.inputs[0] as number) + 1;
  return new UGen(g, 'LocalBuf', 'scalar', [numChannels, numFrames, mlb.outputs[0]], 1, 0, { pure: true }).outputs[0];
}

export const LocalBuf = cls({
  new: (numFrames: unknown = 1, numChannels: unknown = 1) =>
    localBuf(builder(), sig('LocalBuf', 'numFrames', numFrames) as number | Sig, sig('LocalBuf', 'numChannels', numChannels) as number | Sig),
});

// ── VarLag (sclang 3.14: a curved EnvGen unless the warp is linear) ─────────

const SHAPE_NUMBER: Record<string, number> = {
  step: 0, lin: 1, linear: 1, exp: 2, exponential: 2, sin: 3, sine: 3, wel: 4, welch: 4,
  sqr: 6, squared: 6, cub: 7, cubed: 7, hold: 8,
};

function varLag(rate: Rate): Fn {
  return (input: unknown = 0, time: unknown = 0.1, curvature: unknown = 0, warp: unknown = 5, start?: unknown, mul: unknown = 1, add: unknown = 0) => {
    const label = `VarLag.${rate === 'audio' ? 'ar' : 'kr'}`;
    const x = sig(label, 'in', input);
    const t = sig(label, 'time', time);
    if (rateOf(x) === 'scalar' || t === 0) return madd(x, mul as SigLike, add as SigLike);
    const from = start === undefined || start === null ? x : sig(label, 'start', start);
    const curve = typeof warp === 'string' ? SHAPE_NUMBER[warp] ?? 5 : (warp as number);
    if (curve === 1) return madd(raw('VarLag', rate, [x, t, from]), mul as SigLike, add as SigLike);
    // Env([start, in], [time], warp).asArray with the shape and curvature put in place.
    const env: SigLike[] = [from, 1, -99, -99, x, t, curve, sig(label, 'curvature', curvature)];
    let trig = bin('+', changed(rate)(x), raw('Impulse', rate, [0, 0]));
    if (rateOf(t) !== 'scalar') trig = bin('+', trig, changed('control')(t));
    return madd(expanded([trig, 1, 0, 1, 0, ...env], (ins) => ugen('EnvGen', rate, ins, 1, { sideEffect: false })), mul as SigLike, add as SigLike);
  };
}
export const VarLag = cls({ ar: varLag('audio'), kr: varLag('control') });

// ── Pseudo-UGens ────────────────────────────────────────────────────────────

export const Mix = cls({
  new: (a: unknown) => mix(sig('Mix', 'array', a)),
  ar: (a: unknown) => mix(sig('Mix', 'array', a)),
  kr: (a: unknown) => mix(sig('Mix', 'array', a)),
  fill: ((n: unknown, fn: unknown) => {
    if (!isNum(n) || typeof fn !== 'function') throw new GraphError('Mix.fill(n, (i) => signal)');
    return mix(Array.from({ length: n }, (_, i) => fn(i)) as SigLike);
  }) as Fn,
});

export const Splay = cls({
  ar: (a: unknown, spread: unknown = 1, level: unknown = 1, center: unknown = 0, levelComp: unknown = true) =>
    splay(sig('Splay', 'inArray', a), spread as SigLike, level as SigLike, center as SigLike, Boolean(levelComp), 'audio'),
  kr: (a: unknown, spread: unknown = 1, level: unknown = 1, center: unknown = 0, levelComp: unknown = true) =>
    splay(sig('Splay', 'inArray', a), spread as SigLike, level as SigLike, center as SigLike, Boolean(levelComp), 'control'),
});

function pmOsc(rate: Rate): Fn {
  return (carfreq: unknown, modfreq: unknown, pmindex: unknown = 0, modphase: unknown = 0, mul: unknown = 1, add: unknown = 0) => {
    const mod = madd(raw('SinOsc', rate, [sig('PMOsc', 'modfreq', modfreq), sig('PMOsc', 'modphase', modphase)]), sig('PMOsc', 'pmindex', pmindex), 0);
    return madd(raw('SinOsc', rate, [sig('PMOsc', 'carfreq', carfreq), mod]), mul as SigLike, add as SigLike);
  };
}
export const PMOsc = cls({ ar: pmOsc('audio'), kr: pmOsc('control') });

function linLin(): Fn {
  return (input: unknown = 0, srclo: unknown = 0, srchi: unknown = 1, dstlo: unknown = 1, dsthi: unknown = 2) => {
    const scale = bin('/', bin('-', dsthi as SigLike, dstlo as SigLike), bin('-', srchi as SigLike, srclo as SigLike));
    const offset = bin('-', dstlo as SigLike, bin('*', scale, srclo as SigLike));
    return madd(sig('LinLin', 'in', input), scale, offset);
  };
}
export const LinLin = cls({ ar: linLin(), kr: linLin() });

function changed(rate: Rate): Fn {
  return (input: unknown, threshold: unknown = 0) =>
    bin('>', un('abs', raw('HPZ1', rate, [sig('Changed', 'input', input)])), threshold as SigLike);
}
export const Changed = cls({ ar: changed('audio'), kr: changed('control') });

function bPass4(name: 'BLowPass' | 'BHiPass'): Fn {
  return (input: unknown, freq: unknown = 1200, rq: unknown = 1, mul: unknown = 1, add: unknown = 0) => {
    const r = un('sqrt', rq as SigLike);
    const x = toRate(sig(`${name}4`, 'in', input), 'audio');
    const once = raw(name, 'audio', [x, freq as SigLike, r]);
    return madd(raw(name, 'audio', [once, freq as SigLike, r]), mul as SigLike, add as SigLike);
  };
}
export const BLowPass4 = cls({ ar: bPass4('BLowPass') });
export const BHiPass4 = cls({ ar: bPass4('BHiPass') });

function selectX(rate: Rate, xfade: 'XFade2' | 'LinXFade2'): Fn {
  return (which: unknown, array: unknown) => {
    const w = sig('SelectX', 'which', which);
    const arr = list(sig('SelectX', 'array', array));
    const a = raw('Select', rate, [bin('round', w, 2), ...arr]);
    const b = raw('Select', rate, [bin('+', bin('trunc', w, 2), 1), ...arr]);
    const pan = bin('fold2', bin('-', bin('*', w, 2), 1), 1);
    return raw(xfade, rate, [a, b, pan, 1]);
  };
}
export const SelectX = cls({ ar: selectX('audio', 'XFade2'), kr: selectX('control', 'XFade2') });
export const LinSelectX = cls({ ar: selectX('audio', 'LinXFade2'), kr: selectX('control', 'LinXFade2') });

export const Silent = cls({ ar: (n: unknown = 1) => (isNum(n) && n > 1 ? Array.from({ length: n }, () => raw('DC', 'audio', [0])) : raw('DC', 'audio', [0])) });

export const SoundIn = cls({
  ar: (bus: unknown = 0) => {
    const outs = raw('NumOutputBuses', 'scalar', []);
    return expanded([sig('SoundIn', 'bus', bus)], ([b]) => ugen('In', 'audio', [bin('+', outs, b) as number | Sig], 1));
  },
});

function tChoose(rate: Rate): Fn {
  return (trig: unknown, array: unknown) => {
    const arr = list(sig('TChoose', 'array', array));
    return raw('Select', rate, [raw('TIRand', rate, [0, arr.length - 1, sig('TChoose', 'trig', trig)]), ...arr]);
  };
}
export const TChoose = cls({ ar: tChoose('audio'), kr: tChoose('control') });

function tWChoose(rate: Rate): Fn {
  return (trig: unknown, array: unknown, weights: unknown, normalize: unknown = 0) => {
    const arr = list(sig('TWChoose', 'array', array));
    const w = list(sig('TWChoose', 'weights', weights));
    return raw('Select', rate, [raw('TWindex', rate, [sig('TWChoose', 'trig', trig), normalize as SigLike, ...w]), ...arr]);
  };
}
export const TWChoose = cls({ ar: tWChoose('audio'), kr: tWChoose('control') });

export const SPECIAL_CLASSES: Record<string, UGenClass> = {
  Klank, Klang, DynKlank, DynKlang, LocalBuf, VarLag,
  Mix, Splay, PMOsc, LinLin, Changed, BLowPass4, BHiPass4, SelectX, LinSelectX, Silent, SoundIn,
  TChoose, TWChoose,
};
