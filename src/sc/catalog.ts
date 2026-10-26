// Catalog-driven UGen constructors. The catalog (ugen-catalog.json) was
// extracted from sclang 3.14.1 by probing each class with sentinel values and
// re-checking every method against sclang's own SynthDef bytes, so argument
// names, defaults, the order args become inputs, and the constructor quirks
// (bypasses, nil defaults, audio-rate conversions) are sclang's own.

import { Env } from './env';
import {
  GraphError, Sig, UGen, bin, builder, describe, expand, madd, maxRate, rateOf,
  type Rate, type SigLike,
} from './ugen';

export type InputSpec =
  | { arg: string; audioRate?: boolean; numberToImpulse?: boolean; field?: string }
  | { arrayArg: string; extendTo?: string; pad?: number; wrapExtend?: string }
  | { const: number }
  | { arrayLength: string }
  | { string: string }
  | { stringLength: string }
  | { env: string; format: 'envgen' | 'ienvgen' }
  | { spec: string; format: 'klank' | 'klang' }
  | { ugen: string };

export interface ArgSpec {
  name: string;
  default: unknown;
  required?: boolean;
  nilMeans?: { arg: string } | { const: number } | { array: unknown[] } | { expr: string };
}

export interface MethodSpec {
  args: ArgSpec[];
  mulAdd: boolean;
  mulAddIndex?: number;
  rate: Rate | 'fromInputs';
  inputs: InputSpec[];
  numOutputs: number | { arg: string } | { arrayLength: string };
  returns?: { const: number } | { arg: string };
  bypass?: { scalarArg?: string; zeroArg?: string };
  postOps?: { op: string; arg: string }[];
}

export interface UGenSpec {
  serverName: string;
  methods: Partial<Record<'ar' | 'kr' | 'ir' | 'new', MethodSpec>>;
  specialIndex?: number;
  signalRange?: 'bipolar' | 'unipolar';
  pure?: boolean;
  sideEffect?: boolean;
  widthFirst?: boolean;
  checks?: string;
  internal?: boolean;
  special?: string | string[];
  summary?: string;
  argDocs?: Record<string, string>;
  category?: string;
}

export interface Catalog {
  ugens: Record<string, UGenSpec>;
  special?: Record<string, string>;
}

export type Method = 'ar' | 'kr' | 'ir' | 'new';

/** Keyword arguments: a trailing plain object, e.g. EnvGen.kr(env, { doneAction: 2 }). */
export function isKwargs(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}

export interface ResolvedArgs {
  vals: Record<string, unknown>;
  mul: SigLike;
  add: SigLike;
}

const fromCatalog = (d: unknown): unknown => (d === 'inf' ? Infinity : d === '-inf' ? -Infinity : d);

/** Positional + keyword args against an sclang signature. */
export function resolveArgs(label: string, m: Pick<MethodSpec, 'args' | 'mulAdd' | 'mulAddIndex'>, callArgs: unknown[]): ResolvedArgs {
  const names = m.args.map((a) => a.name);
  let all = names;
  if (m.mulAdd) {
    const at = m.mulAddIndex ?? names.length;
    all = [...names.slice(0, at), 'mul', 'add', ...names.slice(at)];
  }
  let positional = callArgs;
  let kw: Record<string, unknown> = {};
  if (callArgs.length && isKwargs(callArgs[callArgs.length - 1])) {
    kw = callArgs[callArgs.length - 1] as Record<string, unknown>;
    positional = callArgs.slice(0, -1);
  }
  if (positional.length > all.length) {
    throw new GraphError(`${label} takes at most ${all.length} arguments (${all.join(', ')}), got ${positional.length}`);
  }
  const given: Record<string, unknown> = {};
  positional.forEach((v, i) => {
    if (v !== undefined && v !== null) given[all[i]] = v;
  });
  for (const [k, v] of Object.entries(kw)) {
    if (!all.includes(k)) throw new GraphError(`${label} has no argument '${k}' (arguments: ${all.join(', ')})`);
    if (k in given) throw new GraphError(`${label}: '${k}' given both by position and by name`);
    if (v !== undefined && v !== null) given[k] = v;
  }
  const vals: Record<string, unknown> = {};
  for (const a of m.args) {
    if (a.name in given) vals[a.name] = given[a.name];
    else {
      const d = fromCatalog(a.default);
      vals[a.name] = d === null ? undefined : d;
    }
  }
  // nil defaults that mean something (Stepper's resetval is min, …)
  for (const a of m.args) {
    if (vals[a.name] !== undefined || !a.nilMeans) continue;
    const n = a.nilMeans;
    if ('arg' in n) vals[a.name] = vals[n.arg];
    else if ('const' in n) vals[a.name] = n.const;
    else if ('array' in n) vals[a.name] = n.array;
  }
  return { vals, mul: (given.mul as SigLike) ?? 1, add: (given.add as SigLike) ?? 0 };
}

function requireSig(label: string, name: string, v: unknown): SigLike {
  if (v === undefined || v === null) throw new GraphError(`${label}: argument '${name}' is required`);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || v instanceof Sig) return v;
  if (Array.isArray(v)) return v.map((x, i) => requireSig(label, `${name}[${i}]`, x));
  if (v instanceof Env) return v.asArray();
  throw new GraphError(`${label}: argument '${name}' must be a signal, number or array, got ${describe(v)}`);
}

const asList = (v: SigLike): SigLike[] => (Array.isArray(v) ? v : [v]);

function isScalar(v: unknown): boolean {
  return typeof v === 'number' || (v instanceof Sig && v.rate === 'scalar');
}

const NOISE = new Set(['WhiteNoise', 'BrownNoise', 'PinkNoise', 'ClipNoise', 'GrayNoise']);

/** sclang's asAudioRateInput: numbers become DC.ar, control signals K2A.ar. */
function toAudio(label: string, x: number | Sig): number | Sig {
  const r = rateOf(x);
  if (r === 'audio' || r === 'demand') return x;
  const g = builder();
  if (typeof x === 'number') return new UGen(g, 'DC', 'audio', [x], 1, 0, { pure: true }).outputs[0];
  g.warn(`${label}: a ${r}-rate input was converted with K2A.ar`);
  return new UGen(g, 'K2A', 'audio', [x], 1, 0, { pure: true }).outputs[0];
}

function toControl(x: number | Sig): number | Sig {
  if (rateOf(x) !== 'audio') return x;
  return new UGen(builder(), 'A2K', 'control', [x], 1, 0, { pure: true }).outputs[0];
}

/** "audioRateInputs(1..)" → from 1; "audioRateInputs(0,2)" → [0, 2]; sameRateAsFirstInput → [0]. */
function audioInputRule(checks: string | undefined): { from?: number; list: number[] } {
  if (!checks) return { list: [] };
  const m = /audioRateInputs\(([^)]*)\)/.exec(checks);
  if (m) {
    const body = m[1].trim();
    if (/^\d+\.\.$/.test(body)) return { from: Number(body.slice(0, -2)), list: [] };
    const list: number[] = [];
    for (const part of body.split(',')) {
      const r = /^(\d+)\.\.(\d+)$/.exec(part.trim());
      if (r) for (let i = Number(r[1]); i <= Number(r[2]); i++) list.push(i);
      else if (part.trim()) list.push(Number(part));
    }
    return { list };
  }
  if (checks.includes('sameRateAsFirstInput')) return { list: [0] };
  return { list: [] };
}

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

/**
 * Build a UGen from its catalog entry: resolve args, lay inputs out in
 * sclang's order, expand multichannel arrays, apply mul/add.
 */
export function construct(className: string, spec: UGenSpec, method: Method, callArgs: unknown[]): SigLike {
  const m = spec.methods[method];
  const label = `${className}.${method}`;
  if (!m) {
    const have = Object.keys(spec.methods).map((k) => `${className}.${k}`).join(', ');
    throw new GraphError(`${label} does not exist (use ${have})`);
  }
  const { vals, mul, add } = resolveArgs(label, m, callArgs);
  for (const a of m.args) {
    if (a.required && (vals[a.name] === undefined || vals[a.name] === null)) {
      throw new GraphError(`${label}: argument '${a.name}' is required`);
    }
  }

  // sclang shortcuts: Lag of a constant (or with lagTime 0) is the constant.
  if (m.bypass) {
    const s = m.bypass.scalarArg;
    const z = m.bypass.zeroArg;
    if ((s && isScalar(vals[s])) || (z && vals[z] === 0)) {
      return madd(requireSig(label, s ?? 'in', vals[s ?? 'in']), mul, add);
    }
  }

  const rateFixed: Rate | null = m.rate === 'fromInputs' ? null : m.rate;
  const audioRule = audioInputRule(spec.checks);

  // Inputs in sclang's order. Array args are spliced in; everything else may expand.
  const flat: unknown[] = [];
  const audioPositions = new Set<number>();
  for (const inp of m.inputs) {
    if ('arg' in inp) {
      if (inp.field) throw new GraphError(`${label}: Rect arguments are not supported`);
      let v: SigLike = requireSig(label, inp.arg, vals[inp.arg]);
      if (inp.numberToImpulse && typeof v === 'number') {
        const r: Rate = rateFixed === 'audio' ? 'audio' : 'control';
        v = new UGen(builder(), 'Impulse', r, [v, 0], 1, 0, { pure: true }).outputs[0];
      }
      if (inp.audioRate && rateFixed === 'audio') audioPositions.add(flat.length);
      flat.push(v);
    } else if ('arrayArg' in inp) {
      let list = asList(requireSig(label, inp.arrayArg, vals[inp.arrayArg] ?? []));
      if (inp.extendTo) {
        const n = asList(requireSig(label, inp.extendTo, vals[inp.extendTo])).length;
        list = Array.from({ length: n }, (_, i) => list[i] ?? inp.pad ?? 0);
      }
      if (inp.wrapExtend) {
        const n = vals[inp.wrapExtend];
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new GraphError(`${label}: '${inp.wrapExtend}' must be a whole number`);
        list = Array.from({ length: n }, (_, i) => list[i % list.length]);
      }
      flat.push(...list);
    } else if ('const' in inp) {
      flat.push(inp.const);
    } else if ('arrayLength' in inp) {
      flat.push(asList(requireSig(label, inp.arrayLength, vals[inp.arrayLength] ?? [])).length);
    } else if ('string' in inp) {
      flat.push(...ascii(String(vals[inp.string] ?? 'UGen')));
    } else if ('stringLength' in inp) {
      flat.push(String(vals[inp.stringLength] ?? 'UGen').length);
    } else if ('env' in inp) {
      const e = vals[inp.env];
      if (!(e instanceof Env) && !Array.isArray(e)) throw new GraphError(`${label}: '${inp.env}' must be an Env`);
      flat.push(...(e instanceof Env ? (inp.format === 'ienvgen' ? e.asArrayForInterpolation() : e.asArray()) : (e as SigLike[])));
    } else if ('spec' in inp || 'ugen' in inp) {
      throw new GraphError(`${label} is built by a dedicated constructor; this path should not be reached`);
    }
  }

  let numOutputs: number;
  if (typeof m.numOutputs === 'number') numOutputs = m.numOutputs;
  else if ('arg' in m.numOutputs) {
    const n = vals[m.numOutputs.arg];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new GraphError(`${label}: '${m.numOutputs.arg}' must be a whole number of channels, got ${describe(n)}`);
    }
    numOutputs = n;
  } else {
    numOutputs = asList(requireSig(label, m.numOutputs.arrayLength, vals[m.numOutputs.arrayLength])).length;
  }

  const sideEffect = Boolean(spec.sideEffect) && !(spec.pure ?? false);
  const doneAction = vals.doneAction;
  const effect = sideEffect || (doneAction !== undefined && doneAction !== 0);
  const g = builder();
  const make = () => expand(flat, (ins) => {
    const rate: Rate = rateFixed ?? (ins as SigLike[]).reduce<Rate>((r, x) => maxRate(r, rateOf(x as SigLike)), 'scalar');
    const inputs = (ins as (number | Sig)[]).map((x, i) => {
      if (rate === 'audio' && (audioPositions.has(i) || audioRule.list.includes(i) || (audioRule.from !== undefined && i >= audioRule.from))) {
        return toAudio(label, x);
      }
      if (rate === 'control' && spec.checks?.includes('sameRateAsFirstInput') && i === 0) return toControl(x);
      if (rate === 'control' && spec.serverName === 'Out' && i > 0) return toControl(x);
      return x;
    });
    const u = new UGen(g, spec.serverName, rate, inputs, numOutputs, spec.specialIndex ?? 0, {
      pure: spec.pure,
      sideEffect: effect,
      widthFirst: spec.widthFirst,
    });
    if (numOutputs === 0) return 0;
    return numOutputs === 1 ? u.outputs[0] : [...u.outputs];
  }) as SigLike;

  let built: SigLike;
  if (NOISE.has(className) && Array.isArray(mul)) {
    // SC2 idiom: WhiteNoise.ar([0.1, 0.1]) makes one noise per mul element.
    built = mul.map((mm) => madd(make(), mm, add));
  } else {
    built = make();
    if (m.mulAdd) built = madd(built, mul, add);
  }
  for (const op of m.postOps ?? []) {
    const v = vals[op.arg];
    if (v !== 1 && v !== undefined) built = bin(op.op as '*', built, v as SigLike);
  }
  if (m.returns) {
    if ('const' in m.returns) return m.returns.const;
    return vals[m.returns.arg] as SigLike;
  }
  return built;
}

/** A namespace object like sclang's class: SinOsc.ar(...), SinOsc.kr(...). */
export function makeUGenClass(className: string, spec: UGenSpec): Record<string, (...a: unknown[]) => SigLike> {
  const cls: Record<string, (...a: unknown[]) => SigLike> = {};
  for (const method of Object.keys(spec.methods) as Method[]) {
    cls[method] = (...args: unknown[]) => construct(className, spec, method, args);
  }
  return cls;
}
