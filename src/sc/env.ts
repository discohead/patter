// Env, as sclang's Env: breakpoint envelopes that EnvGen reads as an array.

import { GraphError, bin, type SigLike } from './ugen';

export type CurveName =
  | 'step' | 'lin' | 'linear' | 'exp' | 'exponential' | 'sin' | 'sine'
  | 'wel' | 'welch' | 'sqr' | 'squared' | 'cub' | 'cubed' | 'hold';
export type Curve = CurveName | number | SigLike;

const SHAPES: Record<CurveName, number> = {
  step: 0, lin: 1, linear: 1, exp: 2, exponential: 2, sin: 3, sine: 3,
  wel: 4, welch: 4, sqr: 6, squared: 6, cub: 7, cubed: 7, hold: 8,
};

function shapeNumber(c: Curve): SigLike {
  if (typeof c === 'string') {
    const s = SHAPES[c as CurveName];
    if (s === undefined) throw new GraphError(`Env: unknown curve '${c}' (use ${Object.keys(SHAPES).join(', ')} or a number)`);
    return s;
  }
  return 5; // a numeric (or signal) curvature
}

function curveValue(c: Curve): SigLike {
  return typeof c === 'string' ? 0 : (c as SigLike);
}

const listOf = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

export class Env {
  readonly levels: SigLike[];
  readonly times: SigLike[];
  readonly curves: Curve | Curve[];
  readonly releaseNode: number | null;
  readonly loopNode: number | null;

  constructor(
    levels: SigLike[] = [0, 1, 0],
    times: SigLike[] = [1, 1],
    curve: Curve | Curve[] = 'lin',
    releaseNode: number | null = null,
    loopNode: number | null = null,
  ) {
    if (!Array.isArray(levels) || levels.length < 1) throw new GraphError('Env: levels must be an array');
    if (!Array.isArray(times)) times = [times];
    if (times.length !== levels.length - 1) {
      // sclang wraps times; do the same but say so only when it can't be intended
      times = Array.from({ length: levels.length - 1 }, (_, i) => times[i % times.length]);
    }
    this.levels = levels;
    this.times = times;
    this.curves = curve;
    this.releaseNode = releaseNode;
    this.loopNode = loopNode;
  }

  static new(levels?: SigLike[], times?: SigLike[], curve?: Curve | Curve[], releaseNode?: number | null, loopNode?: number | null): Env {
    return new Env(levels, times, curve, releaseNode ?? null, loopNode ?? null);
  }

  static perc(attackTime: SigLike = 0.01, releaseTime: SigLike = 1, level: SigLike = 1, curve: Curve = -4): Env {
    return new Env([0, level, 0], [attackTime, releaseTime], curve);
  }

  static adsr(attackTime: SigLike = 0.01, decayTime: SigLike = 0.3, sustainLevel: SigLike = 0.5, releaseTime: SigLike = 1,
    peakLevel: SigLike = 1, curve: Curve = -4, bias: SigLike = 0): Env {
    const lv = [0, peakLevel, mulL(peakLevel, sustainLevel), 0].map((l) => addL(l, bias));
    return new Env(lv, [attackTime, decayTime, releaseTime], curve, 2);
  }

  static dadsr(delayTime: SigLike = 0.1, attackTime: SigLike = 0.01, decayTime: SigLike = 0.3, sustainLevel: SigLike = 0.5,
    releaseTime: SigLike = 1, peakLevel: SigLike = 1, curve: Curve = -4, bias: SigLike = 0): Env {
    const lv = [0, 0, peakLevel, mulL(peakLevel, sustainLevel), 0].map((l) => addL(l, bias));
    return new Env(lv, [delayTime, attackTime, decayTime, releaseTime], curve, 3);
  }

  static asr(attackTime: SigLike = 0.01, sustainLevel: SigLike = 1, releaseTime: SigLike = 1, curve: Curve = -4): Env {
    return new Env([0, sustainLevel, 0], [attackTime, releaseTime], curve, 1);
  }

  static linen(attackTime: SigLike = 0.01, sustainTime: SigLike = 1, releaseTime: SigLike = 1, level: SigLike = 1, curve: Curve = 'lin'): Env {
    return new Env([0, level, level, 0], [attackTime, sustainTime, releaseTime], curve);
  }

  static triangle(dur: SigLike = 1, level: SigLike = 1): Env {
    const half = mulL(dur, 0.5);
    return new Env([0, level, 0], [half, half]);
  }

  static sine(dur: SigLike = 1, level: SigLike = 1): Env {
    const half = mulL(dur, 0.5);
    return new Env([0, level, 0], [half, half], 'sine');
  }

  static cutoff(releaseTime: SigLike = 0.1, level: SigLike = 1, curve: Curve = 'lin'): Env {
    return new Env([level, 0], [releaseTime], curve, 0);
  }

  static step(levels: SigLike[] = [0, 1], times: SigLike[] = [1, 1], releaseNode: number | null = null, loopNode: number | null = null): Env {
    // sclang's Env.step holds each level for its time: levels[0] at t=0.
    return new Env([levels[0], ...levels], times, 'step', releaseNode, loopNode);
  }

  /** Env.pairs([[t0, l0], [t1, l1], ...], curve) */
  static pairs(pairs: [SigLike, SigLike][], curve: Curve | Curve[] = 'lin'): Env {
    const times = pairs.map((p) => p[0] as number);
    const levels = pairs.map((p) => p[1]);
    const deltas = times.slice(1).map((t, i) => t - times[i]);
    return new Env(levels, deltas, curve);
  }

  /** Total duration, when every time is a number. */
  get duration(): number {
    return this.times.reduce<number>((a, t) => a + (typeof t === 'number' ? t : 0), 0);
  }

  /** IEnvGen's layout: [offset, init, numSegs, totalDur, (time, shape, curve, level)…]. */
  asArrayForInterpolation(): SigLike[] {
    const curves = listOf(this.curves);
    const total = this.times.reduce<SigLike>((a, t) => bin('+', a, t), 0);
    const out: SigLike[] = [0, this.levels[0], this.times.length, total];
    for (let i = 0; i < this.times.length; i++) {
      const c = curves[i % curves.length];
      out.push(this.times[i], shapeNumber(c), curveValue(c), this.levels[i + 1]);
    }
    return out;
  }

  /** EnvGen's input layout: [init, numSegs, release, loop, (level, time, shape, curve)…]. */
  asArray(): SigLike[] {
    const curves = listOf(this.curves);
    const out: SigLike[] = [this.levels[0], this.times.length, this.releaseNode ?? -99, this.loopNode ?? -99];
    for (let i = 0; i < this.times.length; i++) {
      const c = curves[i % curves.length];
      out.push(this.levels[i + 1], this.times[i], shapeNumber(c), curveValue(c));
    }
    return out;
  }
}

// Level arithmetic that stays numeric when it can.
function mulL(a: SigLike, b: SigLike): SigLike {
  return bin('*', a, b);
}
function addL(a: SigLike, b: SigLike): SigLike {
  return bin('+', a, b);
}
