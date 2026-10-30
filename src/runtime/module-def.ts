// Compiles a module's patch-language code into a SynthDef.
//
// A module is a named node proxy (JITLib's Ndef): its code returns a signal,
// which is written to the module's own bus through a fade envelope so the
// module can be hot-swapped with a crossfade. `param()` declares knobs,
// `input('other')` reads another module's bus (wired through a control, so
// re-patching never needs a recompile).

import { compileBody, DslError, LoopGuard } from '../sc/dsl';
import { Env } from '../sc/env';
import { baseScope, ugenClasses } from '../sc/scope';
import { finishSynthDef, type SynthDefData } from '../sc/synthdef';
import { GraphBuilder, GraphError, Sig, bin, rateOf, withBuilder, type SigLike } from '../sc/ugen';
import { raw, toRate } from '../sc/methods';
import { makeSampleHandle, moduleKind } from '../sc/samplers';
import { toSpec, type ControlSpec, type SpecInput } from './specs';

export type ModuleKind = 'audio' | 'control' | 'voice';

export interface ModuleShape {
  rate: 'audio' | 'control';
  channels: number;
  /** Named outputs → [first channel, channel count]. */
  outputs: Record<string, [number, number]>;
}

export interface ParamInfo {
  name: string;
  default: number;
  spec: ControlSpec;
  rate: 'control' | 'audio' | 'trigger' | 'scalar';
  label?: string;
  doc?: string;
  size: number;
}

/**
 * One input() read. The ref is kept as written (relative, so the compiled
 * graph is the same for every abstraction instance); the runtime resolves it
 * per instance and sends the bus index on `control`.
 */
export interface ModuleRef {
  ref: string;
  control: string;
  rate: 'audio' | 'control';
  channels: number;
}

/**
 * One sample() a module plays. The ref is kept as written; the runtime
 * resolves it per instance and sends the buffer number, the sample's beats
 * and its root note on these controls.
 */
export interface ModuleSample {
  ref: string;
  control: string;
  beats: string;
  root: string;
  channels: number;
}

/** What sample(ref) is, as the compiler needs to know it. */
export interface SampleShape {
  channels: number;
  frames: number;
  duration: number;
  beats?: number;
  root?: number;
}

/** What input(ref) would read, as the compiler needs to know it. */
export interface InputShape {
  rate: 'audio' | 'control';
  channels: number;
}

export interface CompiledModule {
  /** The graph, named by the caller (see Runtime: content-addressed names). */
  data: SynthDefData;
  kind: ModuleKind;
  params: ParamInfo[];
  refs: ModuleRef[];
  samples: ModuleSample[];
  /** It reports a looping sampler's playhead (on the module's meter id). */
  playhead: boolean;
  shape: ModuleShape;
  warnings: string[];
  ugenCount: number;
}

export interface CompileRequest {
  name: string;
  kind: ModuleKind;
  code: string;
  /** What input(ref) reads; throws with a helpful message when it can't be found. */
  resolve: (ref: string) => InputShape;
  /** What sample(ref) plays; throws when there's no such sample. */
  resolveSample?: (ref: string) => SampleShape;
}

export const INTERNAL = {
  out: '__out',
  gate: '__gate',
  fade: '__fade',
  inPrefix: '__in_',
  samplePrefix: '__smp_',
  beatsPrefix: '__sbt_',
  rootPrefix: '__srt_',
  /** A looping sampler's playhead replies carry the module's meter id. */
  playhead: '__pid',
} as const;

const MAX_CHANNELS = 16;

export class ModuleCompileError extends Error {
  constructor(message: string, readonly line?: number, readonly column?: number) {
    super(message);
    this.name = 'ModuleCompileError';
  }
}

type ParamOpts = { rate?: 'ar' | 'kr' | 'tr' | 'ir'; lag?: number; label?: string; doc?: string };

function controlRateFor(name: string, opts: ParamOpts): ParamInfo['rate'] {
  if (opts.rate === 'ar') return 'audio';
  if (opts.rate === 'tr') return 'trigger';
  if (opts.rate === 'ir') return 'scalar';
  if (opts.rate === 'kr') return 'control';
  if (name.startsWith('t_')) return 'trigger';
  if (name.startsWith('i_')) return 'scalar';
  if (name.startsWith('a_')) return 'audio';
  return 'control';
}

/** Flatten a module's return value into channels plus output names. */
function collectOutputs(result: unknown): { channels: SigLike[]; outputs: Record<string, [number, number]> } {
  const outputs: Record<string, [number, number]> = {};
  const channels: SigLike[] = [];
  const pushSig = (v: unknown, where: string) => {
    if (v === undefined || v === null) throw new ModuleCompileError(`${where} is ${v} — the code must return a signal`);
    if (Array.isArray(v)) {
      const flat = v.flat(Infinity) as unknown[];
      for (const x of flat) pushSig(x, where);
      return;
    }
    if (typeof v === 'number' || v instanceof Sig) {
      channels.push(v);
      return;
    }
    if (typeof v === 'boolean') {
      channels.push(v ? 1 : 0);
      return;
    }
    throw new ModuleCompileError(`${where} must be a signal, number or array of them`);
  };
  if (result && typeof result === 'object' && !Array.isArray(result) && !(result instanceof Sig)) {
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      const start = channels.length;
      pushSig(v, `output '${k}'`);
      outputs[k] = [start, channels.length - start];
    }
  } else {
    pushSig(result, 'the returned value');
  }
  if (channels.length === 0) throw new ModuleCompileError('the code returned no channels');
  if (channels.length > MAX_CHANNELS) throw new ModuleCompileError(`the code returned ${channels.length} channels (max ${MAX_CHANNELS}) — did a multichannel expansion go wider than intended? Mix or Splay it down.`);
  return { channels, outputs };
}

function hasFreeingUGen(g: GraphBuilder): boolean {
  return g.ugens.some((u) => u.sideEffect && u.inputs.length > 0 && ['EnvGen', 'Line', 'XLine', 'Linen', 'DetectSilence', 'FreeSelf', 'FreeSelfWhenDone', 'Free', 'PlayBuf', 'Duty', 'TDuty', 'DemandEnvGen'].includes(u.name));
}

export function compileModule(req: CompileRequest): CompiledModule {
  const g = new GraphBuilder();
  const params: ParamInfo[] = [];
  const refs: ModuleRef[] = [];
  const samples: ModuleSample[] = [];
  moduleKind.set(g, req.kind);
  const guard = new LoopGuard(200_000);
  let line = 0;

  const scope: Record<string, unknown> = {
    ...baseScope(),
    $guard: guard.guard,
    $at: (n: number) => { line = n; },
    param: (name: unknown, dflt: unknown = 0, specOrOpts?: unknown, maybeOpts?: unknown) => {
      if (typeof name !== 'string' || !/^[A-Za-z_][\w]*$/.test(name)) {
        throw new ModuleCompileError(`param name must be an identifier-like string, got ${JSON.stringify(name)}`);
      }
      if (name.startsWith('__')) throw new ModuleCompileError(`param names may not start with '__' (${name})`);
      // scsynth stores control names in 32 bytes (kSCNameLen) and refuses the whole SynthDef otherwise.
      if (name.length > 31) throw new ModuleCompileError(`param '${name}': names can be at most 31 characters (scsynth's limit)`);
      const defaults = Array.isArray(dflt) ? dflt : [dflt];
      if (!defaults.every((d) => typeof d === 'number' && Number.isFinite(d))) {
        throw new ModuleCompileError(`param '${name}': default must be a number (or array of numbers)`);
      }
      // param(name, default, spec, opts) or param(name, default, {min, max, warp, lag, rate, …})
      let specIn: SpecInput = specOrOpts as SpecInput;
      let opts: ParamOpts = (maybeOpts as ParamOpts) ?? {};
      if (specOrOpts && typeof specOrOpts === 'object' && !Array.isArray(specOrOpts)) {
        const { rate, lag, label, doc, ...rest } = specOrOpts as ParamOpts & Record<string, unknown>;
        opts = { rate, lag, label, doc, ...opts };
        specIn = Object.keys(rest).length ? (rest as SpecInput) : undefined;
      }
      let spec: ControlSpec;
      try {
        spec = toSpec(specIn, defaults[0] as number);
      } catch (e) {
        throw new ModuleCompileError(`param '${name}': ${(e as Error).message}`);
      }
      const rate = controlRateFor(name, opts);
      const sigs = g.control(name, rate, defaults as number[]);
      params.push({ name, default: defaults[0] as number, spec, rate, label: opts.label, doc: opts.doc, size: defaults.length });
      let out: SigLike = sigs.length === 1 ? sigs[0] : sigs;
      if (opts.lag && rate !== 'scalar' && rate !== 'trigger') {
        out = raw('Lag', rate === 'audio' ? 'audio' : 'control', [out, opts.lag]);
      }
      return out;
    },
    input: (ref: unknown, opts?: { channels?: number }) => {
      if (typeof ref !== 'string' || !ref) throw new ModuleCompileError(`input() takes a module name like 'osc', 'seq.gate' or 'voice/env'`);
      let shape: InputShape;
      try {
        shape = req.resolve(ref);
      } catch (e) {
        throw new ModuleCompileError(`input('${ref}'): ${(e as Error).message.replace(/^'[^']*': /, '')}`);
      }
      const channels = opts?.channels ? Math.min(shape.channels, opts.channels) : shape.channels;
      // Controls are numbered, not named after the ref: renaming a ref (as
      // grouping does) compiles to the same SynthDef, so the node can stay.
      const seen = refs.find((r) => r.ref === ref);
      const control = seen?.control ?? `${INTERNAL.inPrefix}${refs.length}`;
      let busSig = g.controls.find((c) => c.name === control)?.sigs[0];
      if (!busSig) {
        busSig = g.control(control, 'control', [0])[0];
        refs.push({ ref, control, rate: shape.rate, channels: shape.channels });
      }
      if (shape.rate === 'audio') return raw('InFeedback', 'audio', [busSig], channels, { pure: true });
      return raw('In', 'control', [busSig], channels, { pure: true });
    },
    sample: (ref: unknown) => {
      if (typeof ref !== 'string' || !ref) throw new ModuleCompileError(`sample() takes a sample name like 'amen'`);
      if (!req.resolveSample) throw new ModuleCompileError(`sample('${ref}'): samples aren't available here`);
      let shape: SampleShape;
      try {
        shape = req.resolveSample(ref);
      } catch (e) {
        throw new ModuleCompileError(`sample('${ref}'): ${(e as Error).message}`);
      }
      // Numbered like input()'s controls: the SynthDef doesn't depend on the name.
      let entry = samples.find((x) => x.ref === ref);
      if (!entry) {
        const i = samples.length;
        entry = { ref, control: `${INTERNAL.samplePrefix}${i}`, beats: `${INTERNAL.beatsPrefix}${i}`, root: `${INTERNAL.rootPrefix}${i}`, channels: shape.channels };
        samples.push(entry);
        // Fixed defaults: the runtime sends the real values, and the bytes
        // must not depend on the sample (so instances share one SynthDef).
        g.control(entry.control, 'control', [0]);
        g.control(entry.beats, 'control', [4]);
        g.control(entry.root, 'control', [60]);
      }
      const ctl = (name: string) => g.controls.find((c) => c.name === name)!.sigs[0];
      return makeSampleHandle(ctl(entry.control), {
        sampleName: ref,
        channels: entry.channels,
        beats: ctl(entry.beats),
        root: ctl(entry.root),
        info: { frames: shape.frames, duration: shape.duration, beats: shape.beats, root: shape.root },
      });
    },
  };

  let result: unknown;
  try {
    const fn = compileBody(req.code, Object.keys(scope), { operators: true, loopGuard: true, autoReturn: true, lineMarkers: true });
    result = withBuilder(g, () => fn.run(scope));
  } catch (e) {
    throw wrapError(e, line || undefined);
  }

  let collected: ReturnType<typeof collectOutputs>;
  try {
    collected = withBuilder(g, () => collectOutputs(result));
  } catch (e) {
    throw wrapError(e);
  }
  const { channels, outputs } = collected;
  const outRate: 'audio' | 'control' = req.kind === 'control' ? 'control' : 'audio';
  if (req.kind !== 'control' && channels.every((c) => rateOf(c) !== 'audio')) {
    g.warn(`the ${req.kind} module's output is ${rateOf(channels)} rate; it was converted to audio rate (use kind 'control' for modulation sources)`);
  }

  withBuilder(g, () => {
    const out = g.control(INTERNAL.out, 'control', [0])[0];
    let sig = toRate(channels, outRate) as SigLike[];
    if (req.kind === 'voice') {
      if (!hasFreeingUGen(g)) {
        // A voice must end itself; give it a gate envelope if it has none.
        const gateDecl = g.controls.find((c) => c.name === 'gate');
        const gate = gateDecl ? gateDecl.sigs[0] : (g.control('gate', 'control', [1])[0]);
        if (!gateDecl) params.push({ name: 'gate', default: 1, spec: { min: 0, max: 1, warp: 'lin', step: 1 }, rate: 'control', size: 1 });
        const env = ugenClasses.EnvGen.kr(Env.asr(0.005, 1, 0.05), gate, 1, 0, 1, 2) as SigLike;
        sig = sig.map((c) => bin('*', c, env));
        g.warn('the voice had no envelope that frees it (doneAction: 2); a gate envelope was added — send gate 0 to release');
      }
      raw('Out', outRate, [out, ...sig], 0, { sideEffect: true });
    } else {
      const gate = g.control(INTERNAL.gate, 'control', [1])[0];
      const fade = g.control(INTERNAL.fade, 'control', [0.02])[0];
      const curve = req.kind === 'audio' ? 'sin' : 'lin';
      const env = ugenClasses.EnvGen.kr(new Env([0, 1, 0], [fade, fade], curve, 1), gate, 1, 0, 1, 2) as SigLike;
      raw('Out', outRate, [out, ...sig.map((c) => bin('*', c, env))], 0, { sideEffect: true });
    }
  });

  let built;
  try {
    built = finishSynthDef('pm_pending', g);
  } catch (e) {
    throw wrapError(e);
  }
  return {
    data: built.data,
    kind: req.kind,
    params,
    refs,
    samples,
    playhead: g.controls.some((c) => c.name === INTERNAL.playhead),
    shape: { rate: outRate, channels: channels.length, outputs },
    warnings: built.warnings,
    ugenCount: built.data.ugens.length,
  };
}

function wrapError(e: unknown, line?: number): Error {
  const at = (msg: string) => (line ? `line ${line}: ${msg}` : msg);
  if (e instanceof ModuleCompileError) return e.line || !line ? e : new ModuleCompileError(at(e.message), line);
  if (e instanceof DslError) return new ModuleCompileError(e.line ? e.message : at(e.message), e.line ?? line, e.column);
  if (e instanceof GraphError) return new ModuleCompileError(at(e.message), line);
  const err = e as Error;
  return new ModuleCompileError(at(`${err.name ?? 'Error'}: ${err.message}`), line);
}
