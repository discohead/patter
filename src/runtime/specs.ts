// ControlSpec: what a knob means. Same presets and warps as sclang's Spec.specs.

export type Warp = 'lin' | 'exp' | 'db' | 'amp' | number;

export interface ControlSpec {
  min: number;
  max: number;
  warp: Warp;
  step?: number;
  default?: number;
  unit?: string;
}

export const SPEC_PRESETS: Record<string, ControlSpec> = {
  unipolar: { min: 0, max: 1, warp: 'lin' },
  bipolar: { min: -1, max: 1, warp: 'lin' },
  freq: { min: 20, max: 20000, warp: 'exp', unit: 'Hz' },
  lofreq: { min: 0.1, max: 100, warp: 'exp', unit: 'Hz' },
  midfreq: { min: 25, max: 4200, warp: 'exp', unit: 'Hz' },
  widefreq: { min: 0.1, max: 20000, warp: 'exp', unit: 'Hz' },
  phase: { min: 0, max: 2 * Math.PI, warp: 'lin' },
  rq: { min: 0.001, max: 2, warp: 'exp' },
  audiobus: { min: 0, max: 1023, warp: 'lin', step: 1 },
  controlbus: { min: 0, max: 16383, warp: 'lin', step: 1 },
  midi: { min: 0, max: 127, warp: 'lin', step: 1 },
  midinote: { min: 0, max: 127, warp: 'lin', step: 1 },
  midivelocity: { min: 1, max: 127, warp: 'lin', step: 1 },
  db: { min: -96, max: 0, warp: 'db', unit: 'dB' },
  amp: { min: 0, max: 1, warp: 'amp' },
  boostcut: { min: -20, max: 20, warp: 'lin', unit: 'dB' },
  pan: { min: -1, max: 1, warp: 'lin' },
  detune: { min: -20, max: 20, warp: 'lin', unit: 'Hz' },
  rate: { min: 0.125, max: 8, warp: 'exp' },
  beats: { min: 0, max: 20, warp: 'lin', unit: 'Hz' },
  delay: { min: 0.0001, max: 1, warp: 'exp', unit: 's' },
  time: { min: 0.001, max: 10, warp: 'exp', unit: 's' },
  gain: { min: 0, max: 4, warp: 'amp' },
  q: { min: 0.1, max: 30, warp: 'exp' },
  index: { min: 0, max: 20, warp: 'lin' },
  semitones: { min: -24, max: 24, warp: 'lin', step: 1, unit: 'st' },
  bpm: { min: 20, max: 300, warp: 'lin', unit: 'BPM' },
};

export type SpecInput = string | ControlSpec | [number, number, Warp?, number?] | Partial<ControlSpec> | undefined;

/** Accepts a preset name, a [min, max, warp, step] tuple, or a spec object. */
export function toSpec(s: SpecInput, dflt: number): ControlSpec {
  if (s === undefined || s === null) {
    // Without a spec, make a sensible linear range around the default.
    if (dflt === 0) return { min: 0, max: 1, warp: 'lin' };
    if (dflt > 0 && dflt <= 1) return { min: 0, max: 1, warp: 'lin' };
    if (dflt > 1) return { min: 0, max: dflt * 4, warp: 'lin' };
    return { min: dflt * 4, max: -dflt * 4, warp: 'lin' };
  }
  if (typeof s === 'string') {
    const p = SPEC_PRESETS[s];
    if (!p) throw new Error(`unknown spec '${s}' (presets: ${Object.keys(SPEC_PRESETS).join(', ')})`);
    return { ...p };
  }
  if (Array.isArray(s)) {
    return { min: s[0], max: s[1], warp: s[2] ?? 'lin', step: s[3] };
  }
  const base = s.warp === undefined && s.min !== undefined && s.max !== undefined && s.min > 0 && s.max / s.min >= 100
    ? 'exp' : 'lin';
  return {
    min: s.min ?? 0,
    max: s.max ?? 1,
    warp: s.warp ?? base,
    step: s.step,
    unit: s.unit,
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** value → 0..1 knob position */
export function unmap(spec: ControlSpec, value: number): number {
  const { min, max, warp } = spec;
  if (max === min) return 0;
  switch (warp) {
    case 'lin':
      return clamp01((value - min) / (max - min));
    case 'exp':
      if (min <= 0 || max <= 0) return clamp01((value - min) / (max - min));
      return clamp01(Math.log(Math.max(value, 1e-12) / min) / Math.log(max / min));
    case 'db': {
      // dB with -inf at the bottom: map amplitude-squared like sclang's DbFaderWarp
      const lo = 10 ** (min / 20), hi = 10 ** (max / 20);
      const v = 10 ** (value / 20);
      return clamp01(Math.sqrt((v - lo) / (hi - lo)));
    }
    case 'amp':
      return clamp01(Math.sqrt(Math.max(0, (value - min) / (max - min))));
    default: {
      const c = warp as number;
      if (Math.abs(c) < 0.001) return clamp01((value - min) / (max - min));
      const grow = Math.exp(c);
      const a = (max - min) / (1 - grow);
      const b = min + a;
      return clamp01(Math.log((b - value) / a) / c);
    }
  }
}

/** 0..1 knob position → value */
export function map(spec: ControlSpec, pos: number): number {
  const { min, max, warp } = spec;
  const p = clamp01(pos);
  let v: number;
  switch (warp) {
    case 'lin': v = min + (max - min) * p; break;
    case 'exp': v = min > 0 && max > 0 ? min * (max / min) ** p : min + (max - min) * p; break;
    case 'db': {
      const lo = 10 ** (min / 20), hi = 10 ** (max / 20);
      const amp = lo + (hi - lo) * p * p;
      v = amp <= 0 ? -Infinity : 20 * Math.log10(amp);
      break;
    }
    case 'amp': v = min + (max - min) * p * p; break;
    default: {
      const c = warp as number;
      if (Math.abs(c) < 0.001) { v = min + (max - min) * p; break; }
      const grow = Math.exp(c);
      const a = (max - min) / (1 - grow);
      v = min + a - a * grow ** p;
    }
  }
  if (spec.step) v = Math.round(v / spec.step) * spec.step;
  return v;
}

/** Engine-side warp code used by the modulation summing synth. */
export function warpCode(w: Warp): { code: number; curve: number } {
  if (w === 'lin') return { code: 0, curve: 0 };
  if (w === 'exp') return { code: 1, curve: 0 };
  if (w === 'amp' || w === 'db') return { code: 2, curve: 0 };
  return { code: 3, curve: w as number };
}

export function formatValue(spec: ControlSpec, v: number): string {
  if (!Number.isFinite(v)) return v < 0 ? '-inf' : 'inf';
  const abs = Math.abs(v);
  let s: string;
  if (spec.step && spec.step >= 1) s = String(Math.round(v));
  else if (abs >= 1000) s = `${(v / 1000).toFixed(abs >= 10000 ? 1 : 2)}k`;
  else if (abs >= 100) s = v.toFixed(0);
  else if (abs >= 10) s = v.toFixed(1);
  else if (abs >= 1) s = v.toFixed(2);
  else s = v.toFixed(3);
  return spec.unit ? `${s} ${spec.unit}` : s;
}
