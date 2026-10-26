// sclang's UGen convenience methods (range, linlin, lag, clip, poll…) as
// they are defined in AbstractFunction/UGen, plus a few pseudo-UGens.

import {
  GraphError, Sig, UGen, bin, builder, describe, expand, madd, methods, rateOf, un,
  type ClipMode, type Rate, type SigLike,
} from './ugen';

/** signalRange per server UGen name, filled from the catalog. */
const unipolar = new Set<string>(['LFPulse', 'Impulse', 'Dust', 'Trig', 'Trig1', 'TDelay', 'Sweep', 'Phasor']);

export function setSignalRanges(entries: Iterable<[string, 'bipolar' | 'unipolar' | undefined]>): void {
  for (const [name, range] of entries) {
    if (range === 'unipolar') unipolar.add(name);
    else unipolar.delete(name);
  }
}

function signalRange(s: SigLike): 'bipolar' | 'unipolar' {
  if (s instanceof Sig) return unipolar.has(s.ugen.name) ? 'unipolar' : 'bipolar';
  return 'bipolar';
}

const isNum = (x: unknown): x is number => typeof x === 'number';

/** A UGen by server name with known input order, multichannel-expanding, at the input's rate. */
export function raw(name: string, rate: Rate | null, inputs: SigLike[], numOutputs = 1, flags: { pure?: boolean; sideEffect?: boolean } = { pure: true }): SigLike {
  return expand(inputs, (ins) => {
    const r: Rate = rate ?? (rateOf(ins[0] as SigLike) === 'scalar' ? 'scalar' : rateOf(ins[0] as SigLike));
    for (const x of ins) {
      if (!(typeof x === 'number' || x instanceof Sig)) throw new GraphError(`${name}: bad input ${describe(x)}`);
    }
    const u = new UGen(builder(), name, r, ins as (number | Sig)[], numOutputs, 0, flags);
    return numOutputs === 1 ? u.outputs[0] : numOutputs === 0 ? 0 : [...u.outputs];
  }) as SigLike;
}

/** The rate a method like .lag() runs at: the receiver's, with scalars as control. */
function methodRate(s: SigLike): Rate {
  const r = rateOf(s);
  return r === 'scalar' ? 'control' : r;
}

function prune(s: SigLike, lo: SigLike, hi: SigLike, clip: ClipMode): SigLike {
  switch (clip) {
    case 'minmax': return methods.clip(s, lo, hi);
    case 'min': return bin('max', s, lo);
    case 'max': return bin('min', s, hi);
    default: return s;
  }
}

function perElement(s: SigLike, f: (x: number | Sig) => SigLike): SigLike {
  return Array.isArray(s) ? s.map((x) => perElement(x, f)) : f(s);
}

function clipLike(ugen: 'Clip' | 'Fold' | 'Wrap', num: (x: number, lo: number, hi: number) => number) {
  return (s: SigLike, lo: SigLike, hi: SigLike): SigLike =>
    expand([s, lo, hi], ([x, l, h]) => {
      if (isNum(x) && isNum(l) && isNum(h)) return num(x, l, h);
      if (rateOf(x as SigLike) === 'demand') {
        // sclang: demand-rate clip is max(lo, min(hi, x))
        if (ugen === 'Clip') return bin('max', l as SigLike, bin('min', h as SigLike, x as SigLike));
      }
      const r = rateOf(x as SigLike);
      return raw(ugen, r === 'scalar' ? 'scalar' : r, [x as SigLike, l as SigLike, h as SigLike]);
    }) as SigLike;
}

methods.clip = clipLike('Clip', (x, lo, hi) => Math.min(Math.max(x, lo), hi));
methods.fold = clipLike('Fold', (x, lo, hi) => {
  if (lo === hi) return lo;
  const r = hi - lo, r2 = r * 2;
  let c = (x - lo) % r2;
  if (c < 0) c += r2;
  return c > r ? r2 - c + lo : c + lo;
});
methods.wrap = clipLike('Wrap', (x, lo, hi) => {
  if (lo === hi) return lo;
  const r = hi - lo;
  let c = (x - lo) % r;
  if (c < 0) c += r;
  return c + lo;
});

methods.range = (s, lo, hi) =>
  perElement(s, (x) => {
    if (signalRange(x) === 'bipolar') {
      const mul = bin('*', bin('-', hi, lo), 0.5);
      return madd(x, mul, bin('+', mul, lo));
    }
    return madd(x, bin('-', hi, lo), lo);
  });

methods.exprange = (s, lo, hi) =>
  perElement(s, (x) => (signalRange(x) === 'bipolar'
    ? methods.linexp(x, -1, 1, lo, hi, null)
    : methods.linexp(x, 0, 1, lo, hi, null)));

methods.unipolar = (s, m) => methods.range(s, 0, m);
methods.bipolar = (s, m) => methods.range(s, un('neg', m), m);

methods.linlin = (s, inMin, inMax, outMin, outMax, clip) => {
  const scale = bin('/', bin('-', outMax, outMin), bin('-', inMax, inMin));
  const offset = bin('-', outMin, bin('*', scale, inMin));
  return madd(prune(s, inMin, inMax, clip), scale, offset);
};

methods.linexp = (s, inMin, inMax, outMin, outMax, clip) =>
  expand([s, inMin, inMax, outMin, outMax], ([x, a, b, c, d]) => {
    const pruned = prune(x as SigLike, a as SigLike, b as SigLike, clip);
    if ([pruned, a, b, c, d].every(isNum)) {
      const [p, A, B, C, D] = [pruned, a, b, c, d] as number[];
      return C * (D / C) ** ((p - A) / (B - A));
    }
    return raw('LinExp', methodRate(pruned as SigLike), [pruned, a as SigLike, b as SigLike, c as SigLike, d as SigLike]);
  }) as SigLike;

methods.explin = (s, inMin, inMax, outMin, outMax, clip) => {
  const p = prune(s, inMin, inMax, clip);
  return bin('+', bin('*', bin('/', un('log', bin('/', p, inMin)), un('log', bin('/', inMax, inMin))), bin('-', outMax, outMin)), outMin);
};

methods.expexp = (s, inMin, inMax, outMin, outMax, clip) => {
  const p = prune(s, inMin, inMax, clip);
  return bin('*', bin('pow', bin('/', outMax, outMin), bin('/', un('log', bin('/', p, inMin)), un('log', bin('/', inMax, inMin)))), outMin);
};

methods.lincurve = (s, inMin, inMax, outMin, outMax, curve, clip) => {
  if (isNum(curve) && Math.abs(curve) < 0.125) return methods.linlin(s, inMin, inMax, outMin, outMax, clip);
  const grow = un('exp', curve);
  const a = bin('/', bin('-', outMax, outMin), bin('-', 1, grow));
  const b = bin('+', outMin, a);
  const scaled = bin('/', bin('-', prune(s, inMin, inMax, clip), inMin), bin('-', inMax, inMin));
  const curved = bin('-', b, bin('*', a, bin('pow', grow, scaled)));
  if (isNum(curve)) return curved;
  return raw('Select', methodRate(s), [bin('>=', un('abs', curve), 0.125), methods.linlin(s, inMin, inMax, outMin, outMax, clip), curved]);
};

const lagLike = (name: string) => (s: SigLike, t: SigLike) =>
  perElement(s, (x) => (isNum(x) ? x : raw(name, methodRate(x), [x, t])));
const lagUDLike = (name: string) => (s: SigLike, u: SigLike, d: SigLike) =>
  perElement(s, (x) => (isNum(x) ? x : raw(name, methodRate(x), [x, u, d])));

methods.lag = lagLike('Lag');
methods.lag2 = lagLike('Lag2');
methods.lag3 = lagLike('Lag3');
methods.lagud = lagUDLike('LagUD');
methods.lag3ud = lagUDLike('Lag3UD');
methods.slew = lagUDLike('Slew');

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

methods.poll = (s, trig, label) => {
  perElement(s, (x) => {
    if (isNum(x)) return x;
    const rate: Rate = x.rate === 'audio' ? 'audio' : 'control';
    const t = isNum(trig) ? raw('Impulse', rate, [trig, 0]) : trig;
    const chars = ascii(label);
    raw('Poll', rate, [t, x, -1, chars.length, ...chars], 0, { sideEffect: true });
    return x;
  });
};

// ── Pseudo-UGens ────────────────────────────────────────────────────────────

/** Mix: sum an array of channels (nested arrays are summed element-wise). */
export function mix(arr: SigLike): SigLike {
  if (!Array.isArray(arr)) return arr;
  if (arr.length === 0) return 0;
  return arr.slice(1).reduce<SigLike>((a, b) => bin('+', a, b), arr[0]);
}

/** sclang's Splay: spread channels across the stereo field and sum. */
export function splay(inArray: SigLike, spread: SigLike = 1, level: SigLike = 1, center: SigLike = 0, levelComp = true, rate: 'audio' | 'control' = 'audio'): SigLike {
  const list = Array.isArray(inArray) ? inArray : [inArray];
  const n = Math.max(list.length, 2);
  const n1 = n - 1;
  let lvl = level;
  if (levelComp) lvl = rate === 'audio' ? bin('*', level, Math.sqrt(1 / n)) : bin('/', level, n);
  const positions = Array.from({ length: n }, (_, i) => bin('+', bin('*', i * (2 / n1) - 1, spread), center));
  const panned = raw('Pan2', rate, [toRate(list, rate), positions, 1], 2);
  return bin('*', mix(panned), lvl);
}

export function toRate(x: SigLike, rate: 'audio' | 'control'): SigLike {
  return perElement(x, (v) => {
    const r = rateOf(v);
    if (rate === 'audio' && r !== 'audio' && r !== 'demand') return raw(typeof v === 'number' ? 'DC' : 'K2A', 'audio', [v]);
    if (rate === 'control' && r === 'audio') return raw('A2K', 'control', [v]);
    return v;
  });
}

export { ascii };
