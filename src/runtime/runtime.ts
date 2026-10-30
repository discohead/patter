// Runtime: applies the patch document to the engine and keeps them in step.
//
// Modules are node proxies on their own buses; replacing one's code starts
// the new synth beside the old and crossfades. Modulation routes are summed
// in the engine (one patter_modsum per modulated parameter, n_mapped onto the
// target), so a knob sets the base and every route adds to it, in the
// parameter's own warp. Macros are control buses the UI sets, routed the same way.
//
// Patches nest. A module's path ('voice/filter') places it in a subpatch; its
// input() refs resolve lexically (resolve.ts), and the runtime turns each
// resolution into a bus index on a control — so moving modules between
// subpatches, or re-wiring an inlet, never restarts a node. SynthDefs are
// named by their content, so every instance of an abstraction shares one.

import type { Engine } from '../engine/engine';
import { GROUPS } from '../engine/groups';
import { MOD_SLOTS, MONITOR_CHANNELS } from '../engine/system-defs';
import { encodeSynthDefs, type SynthDefData } from '../sc/synthdef';
import { compileModule, INTERNAL, type CompiledModule, type ModuleKind, type ModuleShape, type ParamInfo } from './module-def';
import {
  checkPath, checkSegment, clonePatch, emptyPatch, join, leafOf, migratePatch, parentOf, relativeTo, within,
  type AbstractionDoc, type InletDoc, type MacroDoc, type ModuleDoc, type PatchDoc, type SampleDoc, type SubpatchDoc, type SurfaceItem,
} from './patch';
export type { SubpatchDoc };
import { childrenOf, instanceRootOf, parseRef, refsInCode, ResolveError, resolveMacro, resolveParam, resolveSample, resolveSource } from './resolve';
import type { SampleSource } from '../engine/samples';
import type { SampleAnalysis } from '../engine/sample-analysis';
import { unmap, warpCode, type ControlSpec } from './specs';
import { analyseAudio, analyseControl, type AudioAnalysis, type ControlAnalysis } from '../engine/analysis';

interface LiveModule {
  path: string;
  compiled: CompiledModule;
  defName: string;
  bus: number;
  node: number | null;
  group: number | null;
  monitor: number | null;
  monitorChannels: number;
  /** A meter synth on the bus while nothing monitors it. */
  meter: number | null;
  meterDef: string;
  meterId: number;
  /** input() control → bus index last sent. */
  wiring: Record<string, number>;
  /** input() control → the module it reads (null: an unconnected inlet). */
  sources: Record<string, string | null>;
  /** sample() control → the patch sample it plays. */
  samples: Record<string, string>;
}

interface LiveModSum {
  node: number;
  bus: number;
}

export interface ModuleReport {
  name: string;
  kind: ModuleKind;
  output: string;
  params: { name: string; value: number; min: number; max: number; warp: string; unit?: string; rate: string; modulated: boolean }[];
  inputs: { ref: string; from: string }[];
  warnings: string[];
  ugens: number;
  replaced: boolean;
  /** The samples it plays: sample(ref) → the patch sample. */
  samples?: { ref: string; sample: string }[];
  /** Set when the module belongs to an abstraction instance and the edit reached its siblings. */
  abstraction?: { name: string; instancesUpdated: string[] };
}

export interface DefineModuleArgs {
  kind: ModuleKind;
  code: string;
  params?: Record<string, number>;
  play?: boolean;
  level?: number;
  pan?: number;
  fadeTime?: number;
  description?: string;
}

export interface MacroArgs {
  label?: string;
  value?: number;
  bipolar?: boolean;
  description?: string;
  targets?: { target: string; amount: number }[];
}

export interface SubpatchArgs {
  description?: string;
  /** name → { from: ref in the parent scope | null, rate?, channels?, description? }; null removes the inlet */
  inlets?: Record<string, (Partial<InletDoc> & { from?: string | null }) | null>;
  /** name → inner ref; null removes */
  outlets?: Record<string, string | null>;
  /** sample slot → a sample name in the parent's scope; null removes */
  samples?: Record<string, string | null>;
  /** name → inner param ref or 'macro:name'; null removes */
  controls?: Record<string, string | null>;
}

type Listener = () => void;

/** An abstraction with nested instances expanded. */
interface Flat {
  modules: AbstractionDoc['modules'];
  subpatches: Record<string, SubpatchDoc>;
  mods: AbstractionDoc['mods'];
  macros: AbstractionDoc['macros'];
}

/** FNV-1a over the bytes, two seeds: a stable content name for a SynthDef. */
function contentHash(bytes: Uint8Array): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b ^ bytes[i], 0x01000197);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Replace quoted occurrences of a path (and its sub-paths and members) in routine code. */
function rewriteQuotedPath(code: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return code.replace(new RegExp(`(['"\`])${esc}(?=['"\`./])`, 'g'), `$1${to}`);
}

export class Runtime {
  doc: PatchDoc = emptyPatch();
  private live = new Map<string, LiveModule>();
  private modsums = new Map<string, LiveModSum>();
  private macroBuses = new Map<string, number>();
  private defUsers = new Map<string, Set<string>>();
  private loadedDefs = new Set<string>();
  private listeners = new Set<Listener>();
  private undoStack: PatchDoc[] = [];
  private redoStack: PatchDoc[] = [];
  private busy: Promise<unknown> = Promise.resolve();
  private silentAudio = -1;

  constructor(
    readonly engine: Engine,
    /** Where samples come from (the browser's bank; a fake in tests). */
    readonly bank: SampleSource | null = null,
  ) {}

  // ── change notification & history ────────────────────────────────────────

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /** Remember the current document so the next change can be undone. */
  checkpoint(): void {
    this.undoStack.push(clonePatch(this.doc));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Forget the undo history (another patch is coming in). */
  resetHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  async undo(): Promise<void> {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(clonePatch(this.doc));
    await this.loadPatch(prev, { keepHistory: true });
  }

  async redo(): Promise<void> {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clonePatch(this.doc));
    await this.loadPatch(next, { keepHistory: true });
  }

  /** Serialise structural operations so concurrent tool calls can't interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.busy.then(fn, fn);
    this.busy = p.catch(() => undefined);
    return p;
  }

  // ── lookups ──────────────────────────────────────────────────────────────

  module(path: string): LiveModule | undefined {
    return this.live.get(path);
  }

  moduleNames(): string[] {
    return Object.keys(this.doc.modules);
  }

  shapeOf(path: string): ModuleShape | null {
    return this.live.get(path)?.compiled.shape ?? null;
  }

  paramInfo(module: string, param: string): ParamInfo | undefined {
    return this.live.get(module)?.compiled.params.find((p) => p.name === param);
  }

  paramValue(module: string, param: string): number {
    const doc = this.doc.modules[module];
    const info = this.paramInfo(module, param);
    return doc?.params[param] ?? info?.default ?? 0;
  }

  meterFor(module: string) {
    const m = this.live.get(module);
    return m ? this.engine.meters.get(m.meterId) : undefined;
  }

  /** Modules whose input() reads resolve to `path`. */
  dependents(path: string): string[] {
    return [...this.live.values()].filter((m) => Object.values(m.sources).includes(path)).map((m) => m.path);
  }

  /** A param ref ('filter.cutoff', 'voice.cutoff', 'macro:dark') → what it controls. */
  resolveParamRef(ref: string, scope = ''): { module: string; param: string; info: ParamInfo } | { macro: string } {
    const r = resolveParam(this.doc, scope, ref);
    if (r.kind === 'macro') return { macro: r.macro };
    const info = this.paramInfo(r.module, r.param);
    if (!info) {
      const live = this.live.get(r.module);
      throw new ResolveError(`'${r.module}' has no param '${r.param}' (params: ${live?.compiled.params.map((p) => p.name).join(', ') || 'none'})`);
    }
    return { module: r.module, param: r.param, info };
  }

  // ── input resolution ─────────────────────────────────────────────────────

  private ensureSilence() {
    if (this.silentAudio < 0) this.silentAudio = this.engine.allocAudio(16);
  }

  /** What module `path`'s input(ref) reads, and on which bus. */
  private resolveInput(path: string, ref: string): { module: string | null; rate: 'audio' | 'control'; channels: number; bus: number } {
    const r = resolveSource(this.doc, parentOf(path), ref);
    if (r.kind === 'silent') {
      this.ensureSilence();
      return { module: null, rate: r.rate, channels: r.channels, bus: r.rate === 'audio' ? this.silentAudio : this.engine.zeroBus };
    }
    if (r.module === path) throw new ResolveError(`a module can't read its own output; use LocalIn/LocalOut for feedback inside a module`);
    const live = this.live.get(r.module);
    if (!live) throw new ResolveError(`'${r.module}' isn't running yet — define it first`);
    const shape = live.compiled.shape;
    let offset = 0;
    let channels = shape.channels;
    if (r.output !== undefined) {
      const named = shape.outputs[r.output];
      if (named) [offset, channels] = named;
      else if (/^\d+$/.test(r.output) && Number(r.output) < shape.channels) {
        offset = Number(r.output);
        channels = 1;
      } else {
        const names = Object.keys(shape.outputs);
        throw new ResolveError(`'${r.module}' has no output '${r.output}' (${names.length ? `outputs: ${names.join(', ')}` : `${shape.channels} unnamed channel(s): '${leafOf(r.module)}.0' …`})`);
      }
    }
    return { module: r.module, rate: shape.rate, channels, bus: live.bus + offset };
  }

  /** The patch sample that sample(ref), in module `path`, plays. */
  private sampleFor(path: string, ref: string): { name: string; doc: SampleDoc } {
    const name = resolveSample(this.doc, parentOf(path), ref);
    return { name, doc: this.doc.samples[name] };
  }

  /** Make sure the buffers a compiled module plays are loaded. */
  private async loadSamplesOf(path: string, compiled: CompiledModule): Promise<void> {
    if (!this.bank) return;
    for (const s of compiled.samples) await this.bank.ensure(this.sampleFor(path, s.ref).doc.src);
  }

  /**
   * Resolve every input() and sample() of a live module to the bus or buffer
   * it means here; report whether the compiled shapes still hold.
   */
  private computeWiring(m: LiveModule): { wiring: Record<string, number>; sources: Record<string, string | null>; samples: Record<string, string>; shapeOk: boolean } {
    const wiring: Record<string, number> = {};
    const sources: Record<string, string | null> = {};
    const samples: Record<string, string> = {};
    let shapeOk = true;
    for (const ref of m.compiled.refs) {
      try {
        const r = this.resolveInput(m.path, ref.ref);
        wiring[ref.control] = r.bus;
        sources[ref.control] = r.module;
        if (r.rate !== ref.rate || r.channels !== ref.channels) shapeOk = false;
      } catch {
        shapeOk = false;
      }
    }
    for (const s of m.compiled.samples) {
      try {
        const { name, doc } = this.sampleFor(m.path, s.ref);
        wiring[s.control] = this.bank?.get(doc.src)?.bufnum ?? -1;
        wiring[s.beats] = doc.beats ?? 4;
        wiring[s.root] = doc.root ?? 60;
        samples[s.control] = name;
        if (doc.channels !== s.channels) shapeOk = false;
      } catch {
        shapeOk = false;
      }
    }
    return { wiring, sources, samples, shapeOk };
  }

  /**
   * Re-resolve every module's inputs after a structural change: re-point the
   * ones whose sources moved, recompile the ones whose sources changed shape.
   */
  private async rewireAll(warnings: string[] = []): Promise<void> {
    const recompile: string[] = [];
    for (const m of this.live.values()) {
      const { wiring, sources, samples, shapeOk } = this.computeWiring(m);
      m.sources = sources;
      m.samples = samples;
      if (!shapeOk) {
        recompile.push(m.path);
        continue;
      }
      const changes: (string | number)[] = [];
      for (const [control, bus] of Object.entries(wiring)) {
        if (m.wiring[control] !== bus) changes.push(control, bus);
      }
      m.wiring = wiring;
      const target = m.node ?? m.group;
      if (changes.length && target !== null) this.engine.send('/n_set', target, ...changes);
    }
    for (const path of recompile) {
      const d = this.doc.modules[path];
      if (!d) continue;
      try {
        await this.defineModuleNow(path, { kind: d.kind, code: d.code }, { cascade: true, fromAbstraction: true });
        warnings.push(`'${path}' was recompiled: what it reads changed`);
      } catch (e) {
        warnings.push(`'${path}' no longer compiles: ${(e as Error).message}`);
      }
    }
    for (const r of this.doc.mods) this.syncModSum(r.target);
    this.orderAudio();
  }

  // ── SynthDef sharing ─────────────────────────────────────────────────────

  private async useDef(path: string, data: SynthDefData): Promise<{ defName: string; bytes: Uint8Array }> {
    const provisional = encodeSynthDefs([{ ...data, name: 'pm' }]);
    const defName = `pm_${contentHash(provisional)}`;
    const bytes = encodeSynthDefs([{ ...data, name: defName }]);
    if (!this.loadedDefs.has(defName)) {
      await this.engine.loadDef(bytes, defName);
      this.loadedDefs.add(defName);
    }
    let users = this.defUsers.get(defName);
    if (!users) this.defUsers.set(defName, (users = new Set()));
    users.add(path);
    return { defName, bytes };
  }

  /** Drop a module's claim on a SynthDef; free it when nobody uses it any more. */
  private releaseDef(path: string, defName: string, delayMs: number) {
    const users = this.defUsers.get(defName);
    users?.delete(path);
    setTimeout(() => {
      const u = this.defUsers.get(defName);
      if (u && u.size === 0) {
        this.defUsers.delete(defName);
        this.loadedDefs.delete(defName);
        this.engine.freeDef(defName);
      }
    }, delayMs);
  }

  // ── modules ──────────────────────────────────────────────────────────────

  defineModule(path: string, args: DefineModuleArgs, opts: { detach?: boolean } = {}): Promise<ModuleReport> {
    return this.exclusive(async () => {
      const report = await this.defineModuleNow(path, args, {});
      if (!opts.detach) {
        const updated = await this.propagateModule(path, args);
        if (updated) report.abstraction = updated;
      }
      return report;
    });
  }

  private ensureSubpatch(path: string) {
    if (!path) return;
    this.ensureSubpatch(parentOf(path));
    if (this.doc.modules[path]) throw new Error(`'${path}' is a module; it can't contain other modules`);
    this.doc.subpatches[path] ??= { inlets: {}, outlets: {}, controls: {} };
  }

  private async defineModuleNow(path: string, args: DefineModuleArgs, opts: { cascade?: boolean; fromAbstraction?: boolean } = {}): Promise<ModuleReport> {
    checkPath(path);
    if (!['audio', 'control', 'voice'].includes(args.kind)) throw new Error(`kind must be audio, control or voice (got ${args.kind})`);
    if (this.doc.subpatches[path]) throw new Error(`'${path}' is a subpatch; pick another name for the module`);
    this.ensureSubpatch(parentOf(path));
    const inletNotes = this.autoInlets(path, args.code);
    const prev = this.live.get(path);
    const prevDoc = this.doc.modules[path];
    if (prev && prev.compiled.kind !== args.kind) {
      // Changing kind changes the node structure; rebuild from scratch.
      await this.removeModuleNow(path, { keepRoutes: true, force: true });
      return this.defineModuleNow(path, args, opts);
    }
    const compiled = compileModule({
      name: path,
      kind: args.kind,
      code: args.code,
      resolve: (ref) => {
        const r = this.resolveInput(path, ref);
        return { rate: r.rate, channels: r.channels };
      },
      resolveSample: (ref) => {
        const { doc } = this.sampleFor(path, ref);
        return { channels: doc.channels, frames: doc.frames, duration: doc.duration, beats: doc.beats, root: doc.root };
      },
    });
    await this.loadSamplesOf(path, compiled);
    const { defName } = await this.useDef(path, compiled.data);
    if (prev && prevDoc && prev.defName === defName) return this.updateInPlace(path, prev, compiled, args, prevDoc);

    const shape = compiled.shape;
    const busCompatible = prev && prev.compiled.shape.rate === shape.rate && prev.compiled.shape.channels === shape.channels;
    const bus = busCompatible ? prev!.bus : shape.rate === 'audio' ? this.engine.allocAudio(shape.channels) : this.engine.allocControl(shape.channels);

    // Document first: node creation reads values from it.
    const keptParams: Record<string, number> = {};
    for (const p of compiled.params) {
      const v = args.params?.[p.name] ?? prevDoc?.params[p.name];
      if (v !== undefined && v !== p.default) keptParams[p.name] = v;
    }
    const docEntry: ModuleDoc = {
      kind: args.kind,
      code: args.code,
      params: keptParams,
      play: args.play ?? prevDoc?.play ?? args.kind !== 'control',
      // The mixer is the person's: redefining a module keeps its fader and pan.
      level: prevDoc?.level ?? args.level ?? 1,
      pan: prevDoc?.pan ?? args.pan ?? 0,
      mute: prevDoc?.mute ?? false,
      ...(prevDoc?.solo ? { solo: true } : {}),
      fadeTime: args.fadeTime ?? prevDoc?.fadeTime ?? (args.kind === 'control' ? 0.2 : 0.5),
      description: args.description ?? prevDoc?.description,
    };
    this.doc.modules[path] = docEntry;

    // Drop routes to params that no longer exist.
    const warnings = [...inletNotes, ...compiled.warnings];
    const lost = this.doc.mods.filter((r) => r.target.startsWith(`${path}.`) && !compiled.params.some((p) => `${path}.${p.name}` === r.target));
    for (const r of lost) {
      warnings.push(`modulation ${r.source} → ${r.target} removed: the param no longer exists`);
      this.doc.mods = this.doc.mods.filter((x) => x !== r);
      this.freeModSum(r.target);
    }

    const live: LiveModule = {
      path,
      compiled,
      defName,
      bus,
      node: null,
      group: prev?.group ?? null,
      monitor: prev?.monitor ?? null,
      monitorChannels: prev?.monitorChannels ?? 0,
      meter: prev?.meter ?? null,
      meterDef: prev?.meterDef ?? '',
      meterId: prev?.meterId ?? this.engine.nextMeterId(),
      wiring: {},
      sources: {},
      samples: {},
    };
    const w = this.computeWiring(live);
    live.wiring = w.wiring;
    live.sources = w.sources;
    live.samples = w.samples;
    this.live.set(path, live);

    if (args.kind === 'voice') {
      if (live.group === null) {
        live.group = this.engine.nextNodeId();
        this.engine.send('/g_new', live.group, 1, GROUPS.audio);
      }
      // Running voices keep the old definition (and bus) and finish on their own.
    } else {
      const fade = prev ? docEntry.fadeTime : args.kind === 'control' ? 0 : 0.02;
      const id = this.engine.nextNodeId();
      const controls = this.nodeControls(live, fade);
      if (prev?.node != null) {
        this.engine.bundle(null, [
          ['/s_new', defName, id, 3, prev.node, ...controls],
          ['/n_set', prev.node, INTERNAL.fade, docEntry.fadeTime, INTERNAL.gate, 0],
        ]);
      } else {
        this.engine.send('/s_new', defName, id, 1, args.kind === 'control' ? GROUPS.control : GROUPS.audio, ...controls);
      }
      live.node = id;
    }

    // Retire the previous definition once its node has faded out.
    if (prev) {
      const delay = (args.kind === 'voice' ? 8 : docEntry.fadeTime + 1) * 1000;
      if (prev.defName !== defName) this.releaseDef(path, prev.defName, delay);
      if (!busCompatible) {
        const oldBus = prev.bus;
        const oldShape = prev.compiled.shape;
        setTimeout(() => {
          if (oldShape.rate === 'audio') this.engine.freeAudio(oldBus, oldShape.channels);
          else this.engine.freeControl(oldBus, oldShape.channels);
        }, delay);
      }
    }

    this.syncMonitor(path);
    this.applyRoutesFor(path);

    // A new module can shadow what a ref in its scope resolved to before
    // (an outer name, an inlet): re-resolve the modules that can see it.
    if (!prev) {
      for (const m of [...this.live.values()]) {
        if (m.path === path || !within(m.path, parentOf(path))) continue;
        const { sources, shapeOk } = this.computeWiring(m);
        if (!Object.entries(sources).some(([c, src]) => m.sources[c] !== src)) continue;
        if (shapeOk) this.repointInputs(m.path);
        else {
          const d = this.doc.modules[m.path];
          try {
            await this.defineModuleNow(m.path, { kind: d.kind, code: d.code }, { cascade: true, fromAbstraction: true });
          } catch (e) {
            warnings.push(`'${m.path}' now reads '${path}' and failed to recompile: ${(e as Error).message}`);
          }
        }
      }
    }

    // Modules reading this one: re-point their inputs, or recompile if the shape changed.
    const shapeChanged = prev && !busCompatible;
    for (const dep of this.dependents(path)) {
      if (dep === path) continue;
      if (shapeChanged && opts.cascade !== false) {
        const d = this.doc.modules[dep];
        try {
          await this.defineModuleNow(dep, { kind: d.kind, code: d.code }, { cascade: true, fromAbstraction: true });
          warnings.push(`'${dep}' was recompiled because '${path}' changed shape`);
        } catch (e) {
          warnings.push(`'${dep}' reads '${path}' and failed to recompile: ${(e as Error).message}`);
        }
      } else {
        this.repointInputs(dep);
      }
    }
    this.orderAudio();
    this.changed();
    return this.report(path, warnings, Boolean(prev));
  }

  /**
   * The code changed but the compiled graph didn't (a comment, a renamed
   * ref): keep the node, take the new text, re-point the inputs.
   */
  private updateInPlace(path: string, live: LiveModule, compiled: CompiledModule, args: DefineModuleArgs, d: ModuleDoc): ModuleReport {
    live.compiled = compiled;
    d.code = args.code;
    if (args.description !== undefined) d.description = args.description;
    if (args.fadeTime !== undefined) d.fadeTime = args.fadeTime;
    if (args.play !== undefined) d.play = args.play;
    if (args.level !== undefined) d.level = args.level;
    if (args.pan !== undefined) d.pan = args.pan;
    this.syncMonitor(path);
    const target = live.node ?? live.group;
    for (const [k, v] of Object.entries(args.params ?? {})) {
      const info = compiled.params.find((p) => p.name === k);
      if (!info) continue;
      if (v === info.default) delete d.params[k];
      else d.params[k] = v;
      const ms = this.modsums.get(`${path}.${k}`);
      if (ms) this.engine.send('/n_set', ms.node, 'pos', unmap(info.spec, v));
      else if (target !== null) this.engine.send('/n_set', target, k, v);
    }
    this.repointInputs(path);
    this.orderAudio();
    this.changed();
    return this.report(path, [...compiled.warnings], true);
  }

  /**
   * A module in a plain subpatch that reads a name from outside gets an inlet
   * for it, named like the source so the code stays as written (through as
   * many levels as it takes). Abstraction instances keep their interfaces explicit.
   */
  private autoInlets(path: string, code: string): string[] {
    const scope = parentOf(path);
    if (!scope || instanceRootOf(this.doc, path)) return [];
    const visible = (s: string, name: string) => {
      const p = join(s, name);
      return Boolean(this.doc.modules[p] || this.doc.subpatches[p] || this.doc.subpatches[s]?.inlets[name]);
    };
    const notes: string[] = [];
    for (const ref of refsInCode(code)) {
      let name: string;
      try {
        const r = parseRef(ref);
        if (r.absolute || r.up > 0) continue;
        name = r.segments[0];
      } catch {
        continue;
      }
      if (visible(scope, name)) continue;
      const chain: string[] = [];
      let s = scope;
      while (s && !visible(s, name)) {
        chain.push(s);
        s = parentOf(s);
      }
      if (!visible(s, name)) continue; // nowhere: the compiler will say so
      for (const sc of chain.reverse()) {
        let rate: 'audio' | 'control' = 'audio';
        let channels = 1;
        try {
          const r = resolveSource(this.doc, parentOf(sc), name);
          if (r.kind === 'module') {
            const shape = this.shapeOf(r.module);
            if (shape) [rate, channels] = [shape.rate, shape.channels];
          } else [rate, channels] = [r.rate, r.channels];
        } catch {
          /* resolved by name; the shape is checked when the module compiles */
        }
        this.doc.subpatches[sc].inlets[name] = { from: name, rate, channels };
        notes.push(`added inlet '${name}' to '${sc}' (← ${name} outside)`);
      }
    }
    return notes;
  }

  /** The /s_new control list for a module node: bus wiring, fade, params. */
  private nodeControls(m: LiveModule, fade: number): (string | number)[] {
    const out: (string | number)[] = [INTERNAL.out, m.bus];
    if (m.compiled.playhead) out.push(INTERNAL.playhead, m.meterId);
    if (m.compiled.kind !== 'voice') out.push(INTERNAL.fade, fade);
    for (const [control, bus] of Object.entries(m.wiring)) out.push(control, bus);
    out.push(...this.paramControls(m));
    return out;
  }

  /** Param values (or "c<bus>" mappings for modulated params). */
  private paramControls(m: LiveModule, overrides: Record<string, number> = {}): (string | number)[] {
    const out: (string | number)[] = [];
    const doc = this.doc.modules[m.path];
    for (const p of m.compiled.params) {
      const ms = this.modsums.get(`${m.path}.${p.name}`);
      if (ms && !(p.name in overrides)) {
        out.push(p.name, `c${ms.bus}`);
        continue;
      }
      const v = overrides[p.name] ?? doc?.params[p.name];
      if (v !== undefined) out.push(p.name, v);
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (!m.compiled.params.some((p) => p.name === k)) out.push(k, v);
    }
    return out;
  }

  private repointInputs(path: string) {
    const m = this.live.get(path);
    if (!m) return;
    const { wiring, sources, samples } = this.computeWiring(m);
    m.sources = sources;
    m.samples = samples;
    const target = m.node ?? m.group;
    const pairs: (string | number)[] = [];
    for (const [control, bus] of Object.entries(wiring)) if (m.wiring[control] !== bus) pairs.push(control, bus);
    m.wiring = wiring;
    if (pairs.length && target !== null) this.engine.send('/n_set', target, ...pairs);
  }

  removeModule(path: string, opts: { force?: boolean; detach?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      const inst = opts.detach ? '' : instanceRootOf(this.doc, path);
      await this.removeModuleNow(path, opts);
      if (inst) await this.propagateRemoval(inst, relativeTo(path, inst));
    });
  }

  private async removeModuleNow(path: string, opts: { force?: boolean; keepRoutes?: boolean } = {}): Promise<void> {
    const m = this.live.get(path);
    if (!m) throw new Error(`no module '${path}'`);
    const deps = this.dependents(path).filter((d) => d !== path);
    if (deps.length && !opts.force) {
      throw new Error(`'${path}' is read by ${deps.join(', ')}; remove or rewrite those first (or force)`);
    }
    const doc = this.doc.modules[path];
    const fade = doc?.fadeTime ?? 0.2;
    if (m.node !== null) this.engine.send('/n_set', m.node, INTERNAL.fade, Math.min(fade, 2), INTERNAL.gate, 0);
    if (m.group !== null) {
      const g = m.group;
      this.engine.send('/n_set', g, 'gate', 0);
      setTimeout(() => this.engine.send('/n_free', g), 4000);
    }
    if (m.monitor !== null) this.engine.send('/n_set', m.monitor, 'fade', Math.min(fade, 2), 'gate', 0);
    this.freeMeter(m);
    const targets = new Set<string>();
    for (const r of this.doc.mods) if (r.target.startsWith(`${path}.`)) targets.add(r.target);
    for (const t of targets) this.freeModSum(t);
    if (!opts.keepRoutes) {
      const touched = this.doc.mods.filter((r) => sourceModule(r.source) === path).map((r) => r.target);
      this.doc.mods = this.doc.mods.filter((r) => !r.target.startsWith(`${path}.`) && sourceModule(r.source) !== path);
      for (const t of new Set(touched)) this.syncModSum(t);
      this.doc.surface = this.doc.surface.filter((s) => !s.ref.startsWith(`${path}.`));
    }
    const shape = m.compiled.shape;
    const delay = (Math.min(fade, 2) + 1) * 1000;
    this.releaseDef(path, m.defName, delay);
    setTimeout(() => {
      if (shape.rate === 'audio') this.engine.freeAudio(m.bus, shape.channels);
      else this.engine.freeControl(m.bus, shape.channels);
    }, delay);
    this.live.delete(path);
    const wasSolo = Boolean(doc?.solo);
    delete this.doc.modules[path];
    if (wasSolo) this.syncMonitors();
    this.changed();
  }

  // ── params ───────────────────────────────────────────────────────────────

  setParam(module: string, param: string, value: number): void {
    const m = this.live.get(module);
    if (!m) throw new Error(`no module '${module}'`);
    const info = m.compiled.params.find((p) => p.name === param);
    if (!info) {
      throw new Error(`'${module}' has no param '${param}' (params: ${m.compiled.params.map((p) => p.name).join(', ') || 'none'})`);
    }
    if (!Number.isFinite(value)) throw new Error(`${module}.${param}: value must be a finite number`);
    const doc = this.doc.modules[module];
    if (value === info.default) delete doc.params[param];
    else doc.params[param] = value;
    const ms = this.modsums.get(`${module}.${param}`);
    if (ms) {
      this.engine.send('/n_set', ms.node, 'pos', unmap(info.spec, value));
    } else {
      const target = m.node ?? m.group;
      if (target !== null) this.engine.send('/n_set', target, param, value);
    }
    this.changed();
  }

  /** Set a param or macro by ref: 'filter.cutoff', 'voice.cutoff' (a control), 'macro:dark'. */
  setByRef(ref: string, value: number, scope = ''): void {
    const r = this.resolveParamRef(ref, scope);
    if ('macro' in r) this.setMacro(r.macro, value);
    else this.setParam(r.module, r.param, value);
  }

  /** The current value behind a ref. */
  valueOf(ref: string, scope = ''): number {
    const r = this.resolveParamRef(ref, scope);
    if ('macro' in r) return this.doc.macros[r.macro]?.value ?? 0;
    return this.paramValue(r.module, r.param);
  }

  setMonitor(module: string, opts: { play?: boolean; level?: number; pan?: number; mute?: boolean; solo?: boolean }): void {
    const doc = this.doc.modules[module];
    if (!doc) throw new Error(`no module '${module}'`);
    const wasSoloing = this.soloing();
    if (opts.play !== undefined) doc.play = opts.play;
    if (opts.level !== undefined) doc.level = Math.max(0, Math.min(4, opts.level));
    if (opts.pan !== undefined) doc.pan = Math.max(-1, Math.min(1, opts.pan));
    if (opts.mute !== undefined) doc.mute = opts.mute;
    if (opts.solo) doc.solo = true;
    else if (opts.solo === false) delete doc.solo;
    // A solo changes what every other module's mute means.
    if (opts.solo !== undefined || this.soloing() !== wasSoloing) this.syncMonitors();
    else this.syncMonitor(module);
    if (opts.play !== undefined) this.propagatePlay(module, opts.play);
    this.changed();
  }

  /** Some module playing into the master is soloed: only soloed ones are heard. */
  soloing(): boolean {
    return Object.values(this.doc.modules).some((d) => d.solo && d.play && d.kind !== 'control');
  }

  /** Muted, or silent because others are soloed. */
  silenced(module: string): boolean {
    const d = this.doc.modules[module];
    return Boolean(d && (d.mute || (!d.solo && this.soloing())));
  }

  private syncMonitors() {
    for (const path of this.live.keys()) this.syncMonitor(path);
  }

  /** Whether a module plays to the mix is part of an abstraction (level, pan and mute stay per instance). */
  private propagatePlay(path: string, play: boolean) {
    const inst = instanceRootOf(this.doc, path);
    if (!inst) return;
    const name = this.doc.subpatches[inst].abstraction!;
    const rel = relativeTo(path, inst);
    const abs = this.doc.abstractions[name];
    if (abs?.modules[rel]) abs.modules[rel].play = play;
    for (const other of this.instancesOf(name)) {
      const d = this.doc.modules[join(other, rel)];
      if (other === inst || !d || d.play === play) continue;
      d.play = play;
      this.syncMonitor(join(other, rel));
    }
  }

  private syncMonitor(path: string) {
    const m = this.live.get(path);
    const doc = this.doc.modules[path];
    if (!m || !doc) return;
    const wants = doc.play && m.compiled.shape.rate === 'audio';
    const channels = m.compiled.shape.channels;
    const monChannels = MONITOR_CHANNELS.find((c) => c >= channels) ?? 16;
    if (!wants) {
      if (m.monitor !== null) {
        this.engine.send('/n_set', m.monitor, 'gate', 0);
        m.monitor = null;
      }
      this.syncMeter(m, monChannels);
      return;
    }
    this.freeMeter(m);
    const settings: (string | number)[] = ['inBus', m.bus, 'out', this.engine.masterBus, 'level', doc.level, 'pan', doc.pan, 'mute', this.silenced(path) ? 1 : 0, 'meterId', m.meterId];
    if (m.monitor !== null && m.monitorChannels === monChannels) {
      this.engine.send('/n_set', m.monitor, ...settings);
      return;
    }
    if (m.monitor !== null) this.engine.send('/n_set', m.monitor, 'gate', 0);
    m.monitor = this.engine.nextNodeId();
    m.monitorChannels = monChannels;
    this.engine.send('/s_new', `patter_monitor_${monChannels}`, m.monitor, 1, GROUPS.monitor, ...settings, 'fade', 0.05);
  }

  /** A module nobody hears still shows its level: a meter synth on its bus. */
  private syncMeter(m: LiveModule, channels: number) {
    const def = `patter_meter_${m.compiled.shape.rate}_${channels}`;
    if (m.meter !== null && m.meterDef === def) {
      this.engine.send('/n_set', m.meter, 'inBus', m.bus);
      return;
    }
    this.freeMeter(m);
    m.meter = this.engine.nextNodeId();
    m.meterDef = def;
    this.engine.send('/s_new', def, m.meter, 1, GROUPS.monitor, 'inBus', m.bus, 'meterId', m.meterId);
  }

  private freeMeter(m: LiveModule) {
    if (m.meter === null) return;
    this.engine.send('/n_free', m.meter);
    m.meter = null;
    m.meterDef = '';
  }

  setTitle(title: string): void {
    this.doc.title = title.trim() || 'untitled patch';
    this.changed();
  }

  setNotes(notes: string): void {
    this.doc.notes = notes;
    this.changed();
  }

  /** End every sounding voice at once (the transport stopped, and their routines with it). */
  silenceVoices(): void {
    for (const m of this.live.values()) if (m.compiled.kind === 'voice' && m.group !== null) this.engine.send('/g_freeAll', m.group);
  }

  setMasterLevel(level: number): void {
    this.doc.master.level = level;
    this.engine.send('/n_set', this.engine.masterNode, 'level', level);
    this.changed();
  }

  // ── modulation ───────────────────────────────────────────────────────────

  /**
   * Route a control signal (or macro) into a param. Refs are full paths, or
   * subpatch outlets/controls ('voice.lfo', 'voice.cutoff'); routes are stored
   * resolved. amount 0 removes the route.
   */
  modulate(source: string, target: string, amount: number): void {
    const { src, tgt } = this.modulateNow(source, target, amount);
    this.propagateRoute(src, tgt, amount);
  }

  private modulateNow(source: string, target: string, amount: number): { src: string; tgt: string } {
    const t = this.resolveParamRef(target);
    if ('macro' in t) throw new Error(`modulation target '${target}' is a macro; macros are sources (route the macro to params instead)`);
    const tgt = `${t.module}.${t.param}`;
    this.checkTarget(tgt);
    const src = this.canonicalSource(source);
    if (!Number.isFinite(amount)) throw new Error('amount must be a number');
    const i = this.doc.mods.findIndex((r) => r.source === src && r.target === tgt);
    if (amount === 0) {
      if (i >= 0) this.doc.mods.splice(i, 1);
    } else if (i >= 0) {
      this.doc.mods[i].amount = amount;
    } else {
      if (this.doc.mods.filter((r) => r.target === tgt).length >= MOD_SLOTS) {
        throw new Error(`${tgt} already has ${MOD_SLOTS} modulation sources`);
      }
      this.doc.mods.push({ source: src, target: tgt, amount });
    }
    this.syncModSum(tgt);
    this.changed();
    return { src, tgt };
  }

  /** 'voice.lfo' (an outlet) → 'voice/lfo'; 'macro:x' → 'macro:<full path>'. */
  private canonicalSource(source: string): string {
    if (source.startsWith('macro:')) {
      const m = resolveMacro(this.doc, '', source.slice(6));
      if (!m) throw new Error(`no macro '${source.slice(6)}'`);
      return `macro:${m}`;
    }
    const r = resolveSource(this.doc, '', source);
    if (r.kind === 'silent') throw new Error(`modulation source '${source}' is an unconnected inlet`);
    const canonical = r.output !== undefined ? `${r.module}.${r.output}` : r.module;
    this.sourceBus(canonical);
    return canonical;
  }

  private checkTarget(target: string): { module: string; param: string; info: ParamInfo; live: LiveModule } {
    const dot = target.lastIndexOf('.');
    const module = target.slice(0, dot);
    const param = target.slice(dot + 1);
    const live = this.live.get(module);
    if (!live) throw new Error(`modulation target '${target}': no module '${module}'`);
    const info = live.compiled.params.find((p) => p.name === param);
    if (!info) throw new Error(`modulation target '${target}': '${module}' has no param '${param}' (params: ${live.compiled.params.map((p) => p.name).join(', ')})`);
    if (info.rate !== 'control') {
      throw new Error(`modulation target '${target}' is a ${info.rate}-rate param; only control-rate params can be modulated (for audio-rate modulation read the source with input() in the code)`);
    }
    return { module, param, info, live };
  }

  /** The control bus a (canonical) modulation source writes. */
  sourceBus(source: string): number {
    if (source.startsWith('macro:')) {
      const name = source.slice(6);
      const bus = this.macroBuses.get(name);
      if (bus === undefined) throw new Error(`no macro '${name}'`);
      return bus;
    }
    const dot = source.indexOf('.');
    const module = dot < 0 ? source : source.slice(0, dot);
    const out = dot < 0 ? undefined : source.slice(dot + 1);
    const m = this.live.get(module);
    if (!m) throw new Error(`modulation source '${source}': no module '${module}'`);
    if (m.compiled.shape.rate !== 'control') {
      throw new Error(`modulation source '${source}' is an audio module; sources must be control modules (make one that reads it, e.g. Amplitude.kr(input('${leafOf(module)}')))`);
    }
    let offset = 0;
    if (out !== undefined) {
      const named = m.compiled.shape.outputs[out];
      if (named) offset = named[0];
      else if (/^\d+$/.test(out) && Number(out) < m.compiled.shape.channels) offset = Number(out);
      else throw new Error(`modulation source '${source}': '${module}' has no output '${out}' (outputs: ${Object.keys(m.compiled.shape.outputs).join(', ') || `${m.compiled.shape.channels} unnamed channel(s)`})`);
    }
    return m.bus + offset;
  }

  private syncModSum(target: string) {
    const routes = this.doc.mods.filter((r) => r.target === target);
    let t;
    try {
      t = this.checkTarget(target);
    } catch {
      this.freeModSum(target);
      return;
    }
    if (routes.length === 0) {
      this.freeModSum(target, true);
      return;
    }
    const spec = t.info.spec;
    const { code } = warpCode(spec.warp);
    const warp = code === 1 && (spec.min <= 0 || spec.max <= 0) ? 0 : code === 3 ? 0 : code;
    const srcs = Array(MOD_SLOTS).fill(this.engine.zeroBus);
    const amts = Array(MOD_SLOTS).fill(0);
    routes.forEach((r, i) => {
      try {
        srcs[i] = this.sourceBus(r.source);
        amts[i] = r.amount;
      } catch {
        /* a source that went away: leave the slot silent */
      }
    });
    const pos = unmap(spec, this.paramValue(t.module, t.param));
    const existing = this.modsums.get(target);
    if (existing) {
      this.engine.bundle(null, [
        ['/n_setn', existing.node, 'srcs', MOD_SLOTS, ...srcs],
        ['/n_setn', existing.node, 'amts', MOD_SLOTS, ...amts],
      ]);
      return;
    }
    const bus = this.engine.allocControl(1);
    const node = this.engine.nextNodeId();
    const nodeTarget = t.live.node ?? t.live.group;
    this.engine.bundle(null, [
      ['/s_new', 'patter_modsum', node, 1, GROUPS.modulation, 'out', bus, 'pos', pos, 'min', spec.min, 'max', spec.max, 'warp', warp, 'step', spec.step ?? 0],
      ['/n_setn', node, 'srcs', MOD_SLOTS, ...srcs],
      ['/n_setn', node, 'amts', MOD_SLOTS, ...amts],
      ...(nodeTarget !== null ? [['/n_map', nodeTarget, t.param, bus] as [string, ...(string | number)[]]] : []),
    ]);
    this.modsums.set(target, { node, bus });
  }

  private freeModSum(target: string, restore = false) {
    const ms = this.modsums.get(target);
    if (!ms) return;
    this.modsums.delete(target);
    const dot = target.lastIndexOf('.');
    const module = target.slice(0, dot);
    const param = target.slice(dot + 1);
    const live = this.live.get(module);
    const nodeTarget = live ? live.node ?? live.group : null;
    const msgs: [string, ...(string | number)[]][] = [];
    if (nodeTarget !== null && restore) {
      msgs.push(['/n_map', nodeTarget, param, -1], ['/n_set', nodeTarget, param, this.paramValue(module, param)]);
    }
    msgs.push(['/n_free', ms.node]);
    this.engine.bundle(null, msgs);
    setTimeout(() => this.engine.freeControl(ms.bus, 1), 500);
  }

  /** After a module's node was replaced, re-sync routes that read from or write to it. */
  private applyRoutesFor(path: string) {
    for (const r of this.doc.mods) {
      if (sourceModule(r.source) === path || r.target.startsWith(`${path}.`)) this.syncModSum(r.target);
    }
  }

  // ── macros ───────────────────────────────────────────────────────────────

  defineMacro(name: string, opts: MacroArgs): void {
    this.defineMacroNow(name, opts);
    this.propagateMacro(name, false);
  }

  private defineMacroNow(name: string, opts: MacroArgs): void {
    checkPath(name, 'macro names');
    if (parentOf(name)) this.ensureSubpatch(parentOf(name));
    const prev = this.doc.macros[name];
    const doc: MacroDoc = {
      value: opts.value ?? prev?.value ?? 0,
      label: opts.label ?? prev?.label,
      description: opts.description ?? prev?.description,
      bipolar: opts.bipolar ?? prev?.bipolar,
    };
    this.doc.macros[name] = doc;
    if (!this.macroBuses.has(name)) this.macroBuses.set(name, this.engine.allocControl(1));
    this.writeMacro(name);
    if (opts.targets) {
      // The given targets replace the macro's routes.
      const source = `macro:${name}`;
      const old = this.doc.mods.filter((r) => r.source === source).map((r) => r.target);
      this.doc.mods = this.doc.mods.filter((r) => r.source !== source);
      for (const t of old) this.syncModSum(t);
      for (const t of opts.targets) this.modulateNow(source, t.target, t.amount);
    }
    if (!parentOf(name) && !this.doc.surface.some((s) => s.ref === `macro:${name}`) && this.doc.surface.length) {
      this.doc.surface.unshift({ ref: `macro:${name}` });
    }
    this.changed();
  }

  setMacro(name: string, value: number): void {
    const doc = this.doc.macros[name];
    if (!doc) throw new Error(`no macro '${name}'`);
    doc.value = Math.min(1, Math.max(0, value));
    this.writeMacro(name);
    this.changed();
  }

  removeMacro(name: string): void {
    this.removeMacroNow(name);
    this.propagateMacro(name, true);
  }

  private removeMacroNow(name: string): void {
    const source = `macro:${name}`;
    const targets = this.doc.mods.filter((r) => r.source === source).map((r) => r.target);
    this.doc.mods = this.doc.mods.filter((r) => r.source !== source);
    for (const t of targets) this.syncModSum(t);
    delete this.doc.macros[name];
    const bus = this.macroBuses.get(name);
    if (bus !== undefined) {
      this.macroBuses.delete(name);
      setTimeout(() => this.engine.freeControl(bus, 1), 500);
    }
    this.doc.surface = this.doc.surface.filter((s) => s.ref !== source);
    this.changed();
  }

  private writeMacro(name: string) {
    const doc = this.doc.macros[name];
    const bus = this.macroBuses.get(name);
    if (!doc || bus === undefined) return;
    this.engine.send('/c_set', bus, doc.bipolar ? doc.value * 2 - 1 : doc.value);
  }

  // ── samples ──────────────────────────────────────────────────────────────

  /**
   * Put audio in the patch under a name, or change what's there (new audio,
   * its beats, its root). Modules playing it follow at once, without
   * restarting unless the channel count changed. A new loop's beats and a
   * pitched sample's root come from the analysis unless given.
   */
  defineSample(
    name: string,
    args: { src?: string; file?: string; beats?: number | null; root?: number | null; description?: string },
  ): Promise<{ name: string; sample: SampleDoc; analysis: SampleAnalysis | null; users: string[]; warnings: string[] }> {
    return this.exclusive(async () => {
      checkSegment(name, 'sample names');
      if (!this.bank) throw new Error('samples need the audio engine running');
      const prev = this.doc.samples[name];
      const src = args.src ?? prev?.src;
      if (!src) throw new Error(`a new sample needs audio: from 'stock:<name>' (Sonic Pi's pack) or 'lib:<sha256>' (the library)`);
      if (args.beats !== undefined && args.beats !== null && !(args.beats > 0)) throw new Error('beats must be a positive number');
      const loaded = await this.bank.ensure(src);
      const same = prev?.src === src;
      const a = loaded.analysis;
      const sample: SampleDoc = {
        src,
        file: args.file ?? (same ? prev?.file : undefined),
        channels: loaded.channels,
        frames: loaded.frames,
        duration: Math.round(loaded.duration * 10000) / 10000,
        beats: args.beats === null ? undefined : args.beats ?? (same ? prev?.beats : a.kind === 'loop' ? a.beats ?? undefined : undefined),
        root: args.root === null ? undefined : args.root ?? (same ? prev?.root : a.root ?? undefined),
        description: args.description ?? prev?.description,
      };
      for (const k of Object.keys(sample) as (keyof SampleDoc)[]) if (sample[k] === undefined) delete sample[k];
      this.doc.samples[name] = sample;
      const warnings: string[] = [];
      await this.rewireAll(warnings);
      this.releaseSamples();
      this.changed();
      return { name, sample, analysis: a, users: this.sampleUsers(name), warnings };
    });
  }

  /** Take a sample out of the patch (nothing may be playing it). */
  removeSample(name: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.doc.samples[name]) throw new Error(`no sample '${name}'`);
      const users = this.sampleUsers(name);
      if (users.length) throw new Error(`'${name}' is played by ${users.join(', ')}; change or remove those first`);
      delete this.doc.samples[name];
      this.releaseSamples();
      this.changed();
    });
  }

  /** Modules playing a patch sample. */
  sampleUsers(name: string): string[] {
    return [...this.live.values()].filter((m) => Object.values(m.samples).includes(name)).map((m) => m.path);
  }

  /** Let the bank free the buffers no patch sample uses any more. */
  private releaseSamples() {
    this.bank?.keepOnly(new Set(Object.values(this.doc.samples).map((x) => x.src)));
  }

  // ── surface ──────────────────────────────────────────────────────────────

  setSurface(items: SurfaceItem[]): void {
    for (const it of items) this.resolveParamRef(it.ref);
    this.doc.surface = items;
    this.changed();
  }

  // ── subpatches ───────────────────────────────────────────────────────────

  /** Create a subpatch, or change its interface. */
  defineSubpatch(path: string, args: SubpatchArgs = {}): Promise<{ path: string; warnings: string[] }> {
    return this.exclusive(async () => {
      const warnings: string[] = [];
      this.defineSubpatchNow(path, args, warnings);
      const inst = instanceRootOf(this.doc, join(path, '_'));
      if (inst) this.propagateInterface(inst, relativeTo(path, inst));
      await this.rewireAll(warnings);
      this.changed();
      return { path, warnings };
    });
  }

  private defineSubpatchNow(path: string, args: SubpatchArgs, warnings: string[]) {
    checkPath(path, 'subpatch names');
    if (this.doc.modules[path]) throw new Error(`'${path}' is a module, not a subpatch`);
    this.ensureSubpatch(path);
    const sub = this.doc.subpatches[path];
    if (args.description !== undefined) sub.description = args.description;
    for (const [name, decl] of Object.entries(args.inlets ?? {})) {
      checkSegment(name, 'inlet names');
      if (decl === null) {
        delete sub.inlets[name];
        continue;
      }
      const prev = sub.inlets[name];
      const from = decl.from !== undefined ? decl.from : prev?.from ?? null;
      let rate = decl.rate ?? prev?.rate;
      let channels = decl.channels ?? prev?.channels;
      if (from) {
        try {
          const r = resolveSource(this.doc, parentOf(path), from);
          if (r.kind === 'module') {
            const shape = this.shapeOf(r.module);
            if (shape) {
              rate ??= shape.rate;
              channels ??= r.output && shape.outputs[r.output] ? shape.outputs[r.output][1] : shape.channels;
            }
          }
        } catch (e) {
          warnings.push(`inlet '${name}': ${(e as Error).message}`);
        }
      }
      sub.inlets[name] = { from, rate: rate ?? 'audio', channels: channels ?? 1, description: decl.description ?? prev?.description };
    }
    for (const [name, ref] of Object.entries(args.outlets ?? {})) {
      if (ref === null) delete sub.outlets[name];
      else sub.outlets[name] = ref;
    }
    for (const [name, ref] of Object.entries(args.controls ?? {})) {
      checkSegment(name, 'control names');
      if (ref === null) {
        delete sub.controls[name];
        continue;
      }
      try {
        resolveParam(this.doc, path, ref);
      } catch (e) {
        warnings.push(`control '${name}': ${(e as Error).message}`);
      }
      sub.controls[name] = ref;
    }
    for (const [slot, target] of Object.entries(args.samples ?? {})) {
      checkSegment(slot, 'sample slot names');
      if (target === null) {
        if (sub.samples) delete sub.samples[slot];
        continue;
      }
      try {
        resolveSample(this.doc, parentOf(path), target);
      } catch (e) {
        warnings.push(`sample slot '${slot}': ${(e as Error).message}`);
      }
      (sub.samples ??= {})[slot] = target;
    }
  }

  /** Re-key everything at or under `from` to `to` (modules keep running). */
  private movePath(from: string, to: string) {
    const remap = (p: string) => (within(p, from) ? to + p.slice(from.length) : p);
    const remapRef = (ref: string) => {
      if (ref.startsWith('macro:')) return `macro:${remap(ref.slice(6))}`;
      const dot = ref.search(/\.[^/]*$/);
      const path = dot < 0 ? ref : ref.slice(0, dot);
      return remap(path) + (dot < 0 ? '' : ref.slice(dot));
    };
    const rekey = <T,>(rec: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(rec).map(([k, v]) => [remap(k), v]));
    this.doc.modules = rekey(this.doc.modules);
    this.doc.subpatches = rekey(this.doc.subpatches);
    this.doc.macros = rekey(this.doc.macros);
    this.doc.mods = this.doc.mods.map((r) => ({ ...r, source: remapRef(r.source), target: remapRef(r.target) }));
    this.doc.surface = this.doc.surface.map((s) => ({ ...s, ref: remapRef(s.ref) }));
    for (const r of Object.values(this.doc.routines)) r.code = rewriteQuotedPath(r.code, from, to);
    const live = new Map<string, LiveModule>();
    for (const [k, m] of this.live) {
      const nk = remap(k);
      if (nk !== k) {
        const users = this.defUsers.get(m.defName);
        users?.delete(k);
        users?.add(nk);
        m.path = nk;
      }
      live.set(nk, m);
    }
    this.live = live;
    this.modsums = new Map([...this.modsums].map(([k, v]) => [remapRef(k), v]));
    this.macroBuses = new Map([...this.macroBuses].map(([k, v]) => [remap(k), v]));
  }

  /**
   * Encapsulate: move direct children of `scope` into a new subpatch. Refs from
   * inside to outside become inlets named after their sources (so the moved
   * code needs no edits); refs from outside to inside go through outlets.
   */
  groupIntoSubpatch(scope: string, name: string, members: string[], description?: string): Promise<{ path: string; inlets: Record<string, string | null>; outlets: Record<string, string>; rewritten: string[]; warnings: string[] }> {
    return this.exclusive(async () => {
      const warnings: string[] = [];
      const res = await this.structural(join(scope, name), (map) => this.groupNow(map(scope), name, members, description, warnings), warnings);
      this.changed();
      return { ...res, warnings };
    });
  }

  private async groupNow(scope: string, name: string, members: string[], description: string | undefined, warnings: string[]): Promise<{ path: string; inlets: Record<string, string | null>; outlets: Record<string, string>; rewritten: string[] }> {
    checkSegment(name, 'subpatch names');
    const sub = join(scope, name);
    if (this.doc.modules[sub] || this.doc.subpatches[sub]) throw new Error(`'${sub}' already exists`);
    if (members.length === 0) throw new Error('nothing to group');
    const memberSet = new Set(members);
    for (const m of members) {
      const p = join(scope, m);
      if (!this.doc.modules[p] && !this.doc.subpatches[p]) throw new Error(`no '${p}' to group`);
    }
    const inlets: Record<string, InletDoc> = {};
    const codeEdits = new Map<string, string>();

    // Inside → outside: inlets, named like their sources.
    for (const m of members) {
      const p = join(scope, m);
      const live = this.live.get(p);
      if (!live) continue; // member subpatches keep their own wiring
      let code = this.doc.modules[p].code;
      for (const ref of live.compiled.refs) {
        const pr = parseRef(ref.ref);
        if (pr.absolute) continue;
        if (pr.up > 0) {
          code = replaceRef(code, ref.ref, `../${ref.ref}`);
          continue;
        }
        const s0 = pr.segments[0];
        if (memberSet.has(s0)) continue;
        if (!inlets[s0]) {
          const r = this.resolveInput(p, s0);
          inlets[s0] = { from: s0, rate: r.rate, channels: this.shapeOf(r.module ?? '')?.channels ?? r.channels };
        }
      }
      if (code !== this.doc.modules[p].code) codeEdits.set(p, code);
    }

    // Outside → inside: outlets. A single outlet becomes the main one ('out').
    const outletRefs = new Map<string, string>(); // outlet name → inner ref
    const outsiders = [...this.live.values()].filter((l) => parentOf(l.path) === scope && !memberSet.has(leafOf(l.path)));
    for (const o of outsiders) {
      for (const ref of o.compiled.refs) {
        const pr = parseRef(ref.ref);
        if (pr.absolute || pr.up > 0) continue;
        if (!memberSet.has(pr.segments[0])) continue;
        const inner = ref.ref; // e.g. 'vca', 'seq.gate', 'voice2/env'
        outletRefs.set(inner, inner);
      }
    }
    const outletNames = [...outletRefs.keys()];
    const single = outletNames.length === 1;
    const outlets: Record<string, string> = {};
    for (const inner of outletNames) outlets[single ? 'out' : inner.replace(/[^a-z0-9_]/g, '_')] = inner;
    for (const o of outsiders) {
      let code = codeEdits.get(o.path) ?? this.doc.modules[o.path].code;
      for (const ref of o.compiled.refs) {
        const pr = parseRef(ref.ref);
        if (pr.absolute || pr.up > 0 || !memberSet.has(pr.segments[0])) continue;
        const outlet = single ? null : ref.ref.replace(/[^a-z0-9_]/g, '_');
        code = replaceRef(code, ref.ref, outlet ? `${name}.${outlet}` : name);
      }
      if (code !== this.doc.modules[o.path].code) codeEdits.set(o.path, code);
    }

    // Move, declare the interface, then rewrite what needs rewriting.
    this.doc.subpatches[sub] = { description, inlets: {}, outlets: {}, controls: {} };
    for (const m of members) this.movePath(join(scope, m), join(sub, m));
    this.doc.subpatches[sub].inlets = inlets;
    this.doc.subpatches[sub].outlets = outlets;
    const rewritten: string[] = [];
    for (const [p, code] of codeEdits) {
      const np = parentOf(p) === scope && memberSet.has(leafOf(p)) ? join(sub, leafOf(p)) : p;
      const d = this.doc.modules[np];
      if (!d) continue;
      try {
        await this.defineModuleNow(np, { kind: d.kind, code }, { fromAbstraction: true });
        rewritten.push(np);
      } catch (e) {
        warnings.push(`'${np}': ${(e as Error).message}`);
      }
    }
    await this.rewireAll(warnings);
    return { path: sub, inlets: Object.fromEntries(Object.entries(inlets).map(([k, v]) => [k, v.from])), outlets, rewritten };
  }

  /** Dissolve a subpatch into its parent (the reverse of grouping). */
  ungroup(path: string): Promise<{ moved: string[]; rewritten: string[]; warnings: string[] }> {
    return this.exclusive(async () => {
      const warnings: string[] = [];
      const res = await this.structural(path, (map) => this.ungroupNow(map(path), warnings), warnings);
      this.changed();
      return { ...res, warnings };
    });
  }

  private async ungroupNow(path: string, warnings: string[]): Promise<{ moved: string[]; rewritten: string[] }> {
    const sub = this.doc.subpatches[path];
    if (!sub) throw new Error(`no subpatch '${path}'`);
    const scope = parentOf(path);
    const name = leafOf(path);
    const { modules, subpatches } = childrenOf(this.doc, path);
    const codeEdits = new Map<string, string>();
    // Inside: inlet refs become their sources; '../' climbs one level less.
    for (const p of modules) {
      const live = this.live.get(p);
      if (!live) continue;
      let code = this.doc.modules[p].code;
      for (const ref of live.compiled.refs) {
        const pr = parseRef(ref.ref);
        if (pr.absolute) continue;
        if (pr.up > 0) {
          code = replaceRef(code, ref.ref, ref.ref.slice(3));
          continue;
        }
        const inlet = sub.inlets[pr.segments[0]];
        const isSibling = this.doc.modules[join(path, pr.segments[0])] || this.doc.subpatches[join(path, pr.segments[0])];
        if (inlet && !isSibling) {
          if (inlet.from === null) {
            warnings.push(`'${p}' read the unconnected inlet '${pr.segments[0]}'; it now has nothing to read`);
            continue;
          }
          const out = pr.output ? `.${pr.output}` : '';
          if (inlet.from !== pr.segments[0] || out) code = replaceRef(code, ref.ref, inlet.from + (inlet.from.includes('.') ? '' : out));
        }
      }
      if (code !== this.doc.modules[p].code) codeEdits.set(p, code);
    }
    // Outside: reads of the subpatch's outlets become reads of what they pointed at.
    for (const o of this.live.values()) {
      if (parentOf(o.path) !== scope || o.path === path) continue;
      let code = codeEdits.get(o.path) ?? this.doc.modules[o.path].code;
      for (const ref of o.compiled.refs) {
        const pr = parseRef(ref.ref);
        if (pr.absolute || pr.up > 0 || pr.segments[0] !== name) continue;
        if (pr.segments.length > 1) {
          code = replaceRef(code, ref.ref, ref.ref.slice(name.length + 1));
          continue;
        }
        const outlet = pr.output ?? Object.keys(sub.outlets)[0];
        const inner = sub.outlets[outlet];
        if (inner) code = replaceRef(code, ref.ref, inner);
      }
      if (code !== this.doc.modules[o.path].code) codeEdits.set(o.path, code);
    }
    // Routes and the surface may point at the subpatch's controls: resolve them now.
    for (const s of this.doc.surface) {
      if (s.ref.startsWith(`${path}.`)) {
        try {
          const r = this.resolveParamRef(s.ref);
          s.ref = 'macro' in r ? `macro:${r.macro}` : `${r.module}.${r.param}`;
        } catch {
          /* leave it */
        }
      }
    }
    const moved: string[] = [];
    for (const child of [...modules, ...subpatches]) {
      let target = join(scope, leafOf(child));
      let n = 2;
      while ((this.doc.modules[target] || this.doc.subpatches[target]) && target !== child) target = join(scope, `${leafOf(child)}_${n++}`);
      if (target !== join(scope, leafOf(child))) warnings.push(`'${child}' became '${target}' (name taken)`);
      const editsFor = codeEdits.get(child);
      this.movePath(child, target);
      if (editsFor !== undefined) {
        codeEdits.delete(child);
        codeEdits.set(target, editsFor);
      }
      moved.push(target);
    }
    for (const [k, v] of Object.entries(this.doc.macros)) if (parentOf(k) === path) this.movePath(k, join(scope, leafOf(k))), void v;
    delete this.doc.subpatches[path];
    const rewritten: string[] = [];
    for (const [p, code] of codeEdits) {
      const d = this.doc.modules[p];
      if (!d) continue;
      try {
        await this.defineModuleNow(p, { kind: d.kind, code }, { fromAbstraction: true });
        rewritten.push(p);
      } catch (e) {
        warnings.push(`'${p}': ${(e as Error).message}`);
      }
    }
    await this.rewireAll(warnings);
    return { moved, rewritten };
  }

  /** Remove a subpatch and everything in it. */
  removeSubpatch(path: string, opts: { force?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      await this.structural(path, (map) => this.removeSubpatchNow(map(path), opts), []);
      this.changed();
    });
  }

  private async removeSubpatchNow(path: string, opts: { force?: boolean }): Promise<void> {
    if (!this.doc.subpatches[path]) throw new Error(`no subpatch '${path}'`);
    const inside = Object.keys(this.doc.modules).filter((p) => within(p, path));
    const readers = [...this.live.values()].filter((m) => !within(m.path, path) && Object.values(m.sources).some((s) => s && within(s, path)));
    if (readers.length && !opts.force) throw new Error(`'${path}' is read by ${readers.map((r) => r.path).join(', ')}; rewrite those first (or force)`);
    for (const p of inside.sort((a, b) => b.length - a.length)) await this.removeModuleNow(p, { force: true });
    for (const k of Object.keys(this.doc.macros)) if (within(k, path)) this.removeMacroNow(k);
    for (const k of Object.keys(this.doc.subpatches)) if (within(k, path)) delete this.doc.subpatches[k];
    await this.rewireAll();
  }

  // ── abstractions ─────────────────────────────────────────────────────────
  //
  // An abstraction is a subpatch definition; its instances are subpatches
  // linked to it by name. Editing a module, route, macro or the interface in
  // any instance changes the definition and every other instance; knob values
  // and inlet connections stay each instance's own. An instance nested inside
  // an abstraction is kept by reference, so the inner definition stays one thing.

  /** Turn a subpatch into an abstraction; the subpatch becomes its first instance. */
  saveAbstraction(path: string, name: string, description?: string): Promise<AbstractionDoc> {
    return this.exclusive(async () => {
      checkSegment(name, 'abstraction names');
      const sub = this.doc.subpatches[path];
      if (!sub) throw new Error(`no subpatch '${path}'`);
      const others = this.instancesOf(name).filter((p) => p !== path);
      if (others.length) throw new Error(`abstraction '${name}' already has instances (${others.join(', ')}); pick another name`);
      if (description) sub.description = description;
      const abs = this.snapshot(path, description);
      this.flatten(abs, [name]); // refuses an abstraction that would contain itself
      this.doc.abstractions[name] = abs;
      await this.structural(path, async (map) => {
        const s = this.doc.subpatches[map(path)];
        if (!s) throw new Error(`no subpatch '${map(path)}'`);
        s.abstraction = name;
        if (description) s.description = description;
      }, []);
      this.changed();
      return abs;
    });
  }

  /** Make a new instance of an abstraction at `path`. */
  instantiate(name: string, path: string, opts: { inlets?: Record<string, string | null>; samples?: Record<string, string>; params?: Record<string, number>; description?: string } = {}): Promise<{ path: string; modules: string[]; warnings: string[] }> {
    return this.exclusive(async () => {
      const warnings: string[] = [];
      const modules = await this.structural(path, (map) => this.instantiateNow(name, map(path), opts, warnings), warnings);
      this.changed();
      return { path, modules, warnings };
    });
  }

  private async instantiateNow(name: string, path: string, opts: { inlets?: Record<string, string | null>; samples?: Record<string, string>; params?: Record<string, number>; description?: string }, warnings: string[]): Promise<string[]> {
    const abs = this.doc.abstractions[name];
    if (!abs) throw new Error(`no abstraction '${name}' (have: ${Object.keys(this.doc.abstractions).join(', ') || 'none'})`);
    checkPath(path, 'subpatch names');
    if (this.doc.modules[path] || this.doc.subpatches[path]) throw new Error(`'${path}' already exists`);
    this.ensureSubpatch(parentOf(path));
    const modules = await this.materialize(this.flatten(abs, [name]), path, { ...opts, link: name }, warnings);
    await this.rewireAll(warnings);
    return modules;
  }

  /** Copy a module or subpatch (an abstraction instance's copy is another instance). */
  duplicate(path: string, to?: string): Promise<{ path: string; warnings: string[] }> {
    return this.exclusive(async () => {
      const target = to ?? this.freeName(parentOf(path), leafOf(path));
      const warnings: string[] = [];
      await this.structural(target, (map) => this.duplicateNow(map(path), map(target), warnings), warnings);
      this.changed();
      return { path: target, warnings };
    });
  }

  private async duplicateNow(path: string, target: string, warnings: string[]): Promise<void> {
    checkPath(target);
    if (this.doc.modules[target] || this.doc.subpatches[target]) throw new Error(`'${target}' already exists`);
    const m = this.doc.modules[path];
    if (m) {
      const args: DefineModuleArgs = { kind: m.kind, code: m.code, params: { ...m.params }, play: m.play, level: m.level, pan: m.pan, fadeTime: m.fadeTime, description: m.description };
      warnings.push(...(await this.defineModuleNow(target, args, { fromAbstraction: true })).warnings);
      return;
    }
    const sub = this.doc.subpatches[path];
    if (!sub) throw new Error(`nothing at '${path}'`);
    this.ensureSubpatch(parentOf(target));
    const inlets = Object.fromEntries(Object.entries(sub.inlets).map(([k, v]) => [k, v.from]));
    const flat = this.flatten(this.snapshot(path), sub.abstraction ? [sub.abstraction] : []);
    await this.materialize(flat, target, { inlets, link: sub.abstraction, description: sub.description }, warnings);
    await this.rewireAll(warnings);
  }

  /** Cut an instance loose from its abstraction (later edits stay local). */
  detach(path: string): Promise<void> {
    return this.exclusive(async () => {
      const sub = this.doc.subpatches[path];
      if (!sub?.abstraction) throw new Error(`'${path}' is not an abstraction instance`);
      await this.structural(path, async (map) => {
        delete this.doc.subpatches[map(path)]?.abstraction;
      }, []);
      this.changed();
    });
  }

  instancesOf(name: string): string[] {
    return Object.entries(this.doc.subpatches).filter(([, s]) => s.abstraction === name).map(([p]) => p);
  }

  /** The next free sibling name: osc → osc_2, osc_3 … */
  private freeName(scope: string, base: string): string {
    const stem = base.replace(/_\d+$/, '').slice(0, 28);
    for (let n = 2; ; n++) {
      const p = join(scope, `${stem}_${n}`);
      if (!this.doc.modules[p] && !this.doc.subpatches[p] && !this.doc.macros[p]) return p;
    }
  }

  /** The innermost abstraction instance that contains both paths ('' if none). */
  private commonInstance(a: string, b: string): string {
    for (let s = parentOf(a); s; s = parentOf(s)) {
      if (this.doc.subpatches[s]?.abstraction && within(b, s) && b !== s) return s;
    }
    return '';
  }

  /** A subpatch as an abstraction definition, relative to it. */
  private snapshot(path: string, description?: string): AbstractionDoc {
    const sub = this.doc.subpatches[path];
    const abs: AbstractionDoc = { description: description ?? sub?.description, modules: {}, subpatches: {}, mods: [], macros: {} };
    // Instances nested inside are kept by reference: their insides belong to their own abstraction.
    const nested = Object.keys(this.doc.subpatches).filter((p) => p !== path && within(p, path) && this.doc.subpatches[p].abstraction);
    const outermost = nested.filter((p) => !nested.some((q) => q !== p && within(p, q)));
    const insideNested = (p: string) => outermost.find((n) => p !== n && within(p, n));
    const overrides: Record<string, number> = {};
    const flats = new Map<string, Flat>();
    for (const [p, m] of Object.entries(this.doc.modules)) {
      if (!within(p, path)) continue;
      const n = insideNested(p);
      if (n) {
        // Remember only the knob values that differ from the inner abstraction's.
        const inner = this.doc.subpatches[n].abstraction!;
        if (!this.doc.abstractions[inner]) continue;
        if (!flats.has(inner)) flats.set(inner, this.flatten(this.doc.abstractions[inner], [inner]));
        const base = flats.get(inner)!.modules[relativeTo(p, n)]?.params ?? {};
        for (const [k, v] of Object.entries(m.params)) if (base[k] !== v) overrides[`${relativeTo(p, path)}.${k}`] = v;
        continue;
      }
      abs.modules[relativeTo(p, path)] = { kind: m.kind, code: m.code, params: { ...m.params }, play: m.play, level: m.level, pan: m.pan, fadeTime: m.fadeTime, description: m.description };
    }
    for (const [p, s] of Object.entries(this.doc.subpatches)) {
      if (!within(p, path) || insideNested(p)) continue;
      const copy = JSON.parse(JSON.stringify(s)) as SubpatchDoc;
      const rel = relativeTo(p, path);
      if (rel === '') {
        for (const i of Object.values(copy.inlets)) i.from = null;
        delete copy.abstraction;
      }
      abs.subpatches[rel] = copy;
    }
    const rel = (ref: string) => (ref.startsWith('macro:') ? `macro:${relativeTo(ref.slice(6), path)}` : relativeTo(ref, path));
    for (const r of this.doc.mods) {
      const src = r.source.startsWith('macro:') ? r.source.slice(6) : sourceModule(r.source)!;
      const tgt = r.target.slice(0, r.target.lastIndexOf('.'));
      if (!within(src, path) || !within(tgt, path) || src === path) continue;
      const c = this.commonInstance(tgt, src);
      if (c && c !== path && within(c, path)) continue; // internal to a nested instance
      abs.mods.push({ source: rel(r.source), target: rel(r.target), amount: r.amount });
    }
    for (const [k, v] of Object.entries(this.doc.macros)) {
      if (within(k, path) && k !== path && !insideNested(k)) abs.macros[relativeTo(k, path)] = { ...v };
    }
    if (Object.keys(overrides).length) abs.overrides = overrides;
    return abs;
  }

  /** An abstraction with its nested instances expanded: everything one instance consists of. */
  private flatten(abs: AbstractionDoc, stack: string[]): Flat {
    const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
    const out: Flat = { modules: clone(abs.modules), subpatches: {}, mods: abs.mods.map((r) => ({ ...r })), macros: clone(abs.macros) };
    for (const [rel, s] of Object.entries(abs.subpatches)) {
      out.subpatches[rel] = clone(s);
      if (!rel || !s.abstraction) continue;
      if (stack.includes(s.abstraction)) throw new Error(`abstraction '${s.abstraction}' would contain itself`);
      const innerDoc = this.doc.abstractions[s.abstraction];
      if (!innerDoc) {
        delete out.subpatches[rel].abstraction;
        continue;
      }
      const inner = this.flatten(innerDoc, [...stack, s.abstraction]);
      const at = (r: string) => (r ? join(rel, r) : rel);
      const atRef = (r: string) => (r.startsWith('macro:') ? `macro:${at(r.slice(6))}` : at(r));
      for (const [r, m] of Object.entries(inner.modules)) out.modules[at(r)] = m;
      for (const [r, sd] of Object.entries(inner.subpatches)) {
        if (r) out.subpatches[at(r)] = sd;
        else {
          // The interface is the inner abstraction's; the connections are this record's.
          const inlets = Object.fromEntries(Object.entries(sd.inlets).map(([k, v]) => [k, { ...v, from: s.inlets[k]?.from ?? null }]));
          out.subpatches[rel] = { ...sd, inlets, abstraction: s.abstraction, description: s.description ?? sd.description };
        }
      }
      for (const r of inner.mods) out.mods.push({ source: atRef(r.source), target: atRef(r.target), amount: r.amount });
      for (const [k, v] of Object.entries(inner.macros)) out.macros[at(k)] = v;
    }
    for (const [ref, v] of Object.entries(abs.overrides ?? {})) {
      const dot = ref.lastIndexOf('.');
      const m = out.modules[ref.slice(0, dot)];
      if (m) m.params = { ...m.params, [ref.slice(dot + 1)]: v };
    }
    return out;
  }

  /** Build an expanded abstraction at `path`. */
  private async materialize(flat: Flat, path: string, opts: { inlets?: Record<string, string | null>; samples?: Record<string, string>; params?: Record<string, number>; description?: string; link?: string }, warnings: string[]): Promise<string[]> {
    for (const [rel, sd] of Object.entries(flat.subpatches)) this.doc.subpatches[rel ? join(path, rel) : path] = JSON.parse(JSON.stringify(sd));
    const root = (this.doc.subpatches[path] ??= { inlets: {}, outlets: {}, controls: {} });
    if (opts.link) root.abstraction = opts.link;
    else delete root.abstraction;
    if (opts.description !== undefined) root.description = opts.description;
    for (const [slot, target] of Object.entries(opts.samples ?? {})) {
      if (!root.samples?.[slot]) warnings.push(`'${path}' has no sample slot '${slot}' (slots: ${Object.keys(root.samples ?? {}).join(', ') || 'none'})`);
      (root.samples ??= {})[slot] = target;
    }
    for (const [inlet, from] of Object.entries(opts.inlets ?? {})) {
      if (!root.inlets[inlet]) {
        warnings.push(`'${path}' has no inlet '${inlet}' (inlets: ${Object.keys(root.inlets).join(', ') || 'none'})`);
        continue;
      }
      root.inlets[inlet].from = from;
    }
    // Every module's document goes in first, so lexical lookups find siblings
    // that aren't built yet; then build in dependency order.
    const pending = new Map(Object.entries(flat.modules).map(([rel, m]) => [join(path, rel), m]));
    for (const [p, m] of pending) this.doc.modules[p] = { ...m, params: { ...m.params }, mute: false };
    const made: string[] = [];
    for (let round = 0; pending.size && round < 50; round++) {
      let progress = false;
      for (const [p, m] of [...pending]) {
        try {
          await this.defineModuleNow(p, { ...m, params: { ...m.params } }, { fromAbstraction: true });
          pending.delete(p);
          made.push(p);
          progress = true;
        } catch (e) {
          if (!(e instanceof Error && /isn't running yet/.test(e.message))) {
            pending.delete(p);
            delete this.doc.modules[p];
            warnings.push(`'${p}': ${(e as Error).message}`);
          }
        }
      }
      if (!progress) break;
    }
    for (const p of pending.keys()) {
      delete this.doc.modules[p];
      warnings.push(`'${p}' couldn't be built: circular or missing input()`);
    }
    for (const [rel, mac] of Object.entries(flat.macros)) this.defineMacroNow(join(path, rel), mac);
    const at = (r: string) => (r.startsWith('macro:') ? `macro:${join(path, r.slice(6))}` : join(path, r));
    for (const r of flat.mods) {
      try {
        this.modulateNow(at(r.source), at(r.target), r.amount);
      } catch (e) {
        warnings.push(`route ${r.source} → ${r.target}: ${(e as Error).message}`);
      }
    }
    for (const [ref, v] of Object.entries(opts.params ?? {})) {
      // 'osc.freq' is inside the instance; a bare name is one of its controls.
      const inner = ref.includes('.') || ref.startsWith('macro:');
      try {
        this.setByRef(inner ? ref : `${leafOf(path)}.${ref}`, v, inner ? path : parentOf(path));
      } catch (e) {
        warnings.push(`param ${ref}: ${(e as Error).message}`);
      }
    }
    return made;
  }

  /**
   * Run a structural edit (grouping, ungrouping, removing, instantiating…) at
   * `at` — and, when that place is inside an abstraction instance, the same
   * edit at the same place in every other instance, so they keep running and
   * keep their knobs. Then the abstraction takes the new shape. An instance
   * that can't follow is rebuilt from the definition.
   */
  private async structural<T>(at: string, edit: (map: (p: string) => string) => Promise<T>, warnings: string[]): Promise<T> {
    const inst = instanceRootOf(this.doc, at);
    const name = inst ? this.doc.subpatches[inst].abstraction : undefined;
    const others = name ? this.instancesOf(name).filter((o) => o !== inst) : [];
    const result = await edit((p) => p);
    if (!inst || !name || !this.doc.subpatches[inst]) return result;
    const failed: string[] = [];
    for (const other of others) {
      if (!this.doc.subpatches[other]) continue;
      const map = (p: string) => (p === inst ? other : within(p, inst) ? join(other, relativeTo(p, inst)) : p);
      try {
        await edit(map);
      } catch (e) {
        warnings.push(`'${other}' couldn't follow the edit (${(e as Error).message}); rebuilt it from '${name}'`);
        failed.push(other);
      }
    }
    this.doc.abstractions[name] = this.snapshot(inst, this.doc.abstractions[name]?.description);
    for (const other of failed) await this.rebuildInstance(other, name, warnings);
    return result;
  }

  /** Rebuild an instance from its abstraction, keeping its connections, knob and macro values. */
  private async rebuildInstance(path: string, name: string, warnings: string[]): Promise<void> {
    const sub = this.doc.subpatches[path];
    const inlets = Object.fromEntries(Object.entries(sub.inlets).map(([k, v]) => [k, v.from]));
    const params: Record<string, number> = {};
    for (const [p, m] of Object.entries(this.doc.modules)) {
      if (within(p, path)) for (const [k, v] of Object.entries(m.params)) params[`${relativeTo(p, path)}.${k}`] = v;
    }
    const macroValues = Object.fromEntries(Object.entries(this.doc.macros).filter(([k]) => within(k, path)).map(([k, v]) => [k, v.value]));
    const inside = Object.keys(this.doc.modules).filter((p) => within(p, path));
    for (const p of inside) await this.removeModuleNow(p, { force: true, keepRoutes: true });
    // Routes from outside into the instance are its own connections and stay; internal ones come back from the definition.
    this.doc.mods = this.doc.mods.filter((r) => {
      const src = r.source.startsWith('macro:') ? r.source.slice(6) : sourceModule(r.source)!;
      return !(within(src, path) && within(r.target.slice(0, r.target.lastIndexOf('.')), path));
    });
    for (const k of Object.keys(this.doc.macros)) if (within(k, path)) this.removeMacroNow(k);
    for (const k of Object.keys(this.doc.subpatches)) if (within(k, path)) delete this.doc.subpatches[k];
    await this.materialize(this.flatten(this.doc.abstractions[name], [name]), path, { inlets, link: name, description: sub.description }, warnings);
    for (const [ref, v] of Object.entries(params)) {
      const dot = ref.lastIndexOf('.');
      const module = join(path, ref.slice(0, dot));
      if (this.paramInfo(module, ref.slice(dot + 1))) this.setParam(module, ref.slice(dot + 1), v);
    }
    for (const [k, v] of Object.entries(macroValues)) if (this.doc.macros[k]) this.setMacro(k, v);
    for (const r of this.doc.mods) if (within(r.target, path)) this.syncModSum(r.target);
  }

  /** A module inside an instance was (re)defined: carry the code to the abstraction and its other instances. */
  private async propagateModule(path: string, args: DefineModuleArgs): Promise<{ name: string; instancesUpdated: string[] } | null> {
    const inst = instanceRootOf(this.doc, path);
    if (!inst) return null;
    const name = this.doc.subpatches[inst].abstraction!;
    const abs = this.doc.abstractions[name];
    if (!abs) return null;
    const rel = relativeTo(path, inst);
    const d = this.doc.modules[path];
    abs.modules[rel] = { kind: d.kind, code: d.code, params: { ...(abs.modules[rel]?.params ?? d.params) }, play: d.play, level: d.level, pan: d.pan, fadeTime: d.fadeTime, description: d.description };
    const updated: string[] = [];
    for (const other of this.instancesOf(name)) {
      if (other === inst) continue;
      const p = join(other, rel);
      const od = this.doc.modules[p];
      if (od && od.code === d.code && od.kind === d.kind) continue;
      await this.defineModuleNow(
        p,
        { kind: args.kind, code: args.code, description: args.description, fadeTime: args.fadeTime, ...(od ? {} : { play: d.play, level: d.level, pan: d.pan }) },
        { fromAbstraction: true },
      );
      updated.push(other);
    }
    return { name, instancesUpdated: updated };
  }

  private async propagateRemoval(inst: string, rel: string) {
    const name = this.doc.subpatches[inst]?.abstraction;
    if (!name) return;
    delete this.doc.abstractions[name]?.modules[rel];
    for (const other of this.instancesOf(name)) {
      if (other === inst) continue;
      const p = join(other, rel);
      if (this.live.has(p)) await this.removeModuleNow(p, { force: true });
    }
  }

  /** A route between two things inside one instance belongs to the abstraction. */
  private propagateRoute(src: string, tgt: string, amount: number) {
    const srcPath = src.startsWith('macro:') ? src.slice(6) : sourceModule(src)!;
    const inst = this.commonInstance(tgt.slice(0, tgt.lastIndexOf('.')), srcPath);
    if (!inst) return;
    const name = this.doc.subpatches[inst].abstraction!;
    const abs = this.doc.abstractions[name];
    if (!abs) return;
    const rel = (ref: string) => (ref.startsWith('macro:') ? `macro:${relativeTo(ref.slice(6), inst)}` : relativeTo(ref, inst));
    const at = (other: string, r: string) => (r.startsWith('macro:') ? `macro:${join(other, r.slice(6))}` : join(other, r));
    const [rs, rt] = [rel(src), rel(tgt)];
    abs.mods = abs.mods.filter((r) => !(r.source === rs && r.target === rt));
    if (amount !== 0) abs.mods.push({ source: rs, target: rt, amount });
    for (const other of this.instancesOf(name)) {
      if (other === inst) continue;
      try {
        this.modulateNow(at(other, rs), at(other, rt), amount);
      } catch {
        /* that instance has diverged: leave it */
      }
    }
  }

  /** A macro inside an instance belongs to the abstraction (its value stays per instance). */
  private propagateMacro(name: string, removed: boolean) {
    const inst = instanceRootOf(this.doc, name);
    const absName = inst ? this.doc.subpatches[inst].abstraction! : '';
    const abs = absName ? this.doc.abstractions[absName] : undefined;
    if (!inst || !abs) return;
    const rel = relativeTo(name, inst);
    const source = `macro:${rel}`;
    abs.mods = abs.mods.filter((r) => r.source !== source);
    if (removed) delete abs.macros[rel];
    else {
      const d = this.doc.macros[name];
      abs.macros[rel] = { ...d };
      for (const r of this.doc.mods) {
        if (r.source === `macro:${name}` && within(r.target, inst)) abs.mods.push({ source, target: relativeTo(r.target, inst), amount: r.amount });
      }
    }
    for (const other of this.instancesOf(absName)) {
      if (other === inst) continue;
      const p = join(other, rel);
      try {
        if (removed) {
          if (this.doc.macros[p]) this.removeMacroNow(p);
          continue;
        }
        const d = abs.macros[rel];
        const targets = abs.mods.filter((r) => r.source === source).map((r) => ({ target: join(other, r.target), amount: r.amount }));
        this.defineMacroNow(p, { label: d.label, description: d.description, bipolar: d.bipolar, value: this.doc.macros[p] ? undefined : d.value, targets });
      } catch {
        /* that instance has diverged: leave it */
      }
    }
  }

  /** A subpatch inside an instance changed its interface: so do the abstraction and its other instances. */
  private propagateInterface(inst: string, rel: string) {
    const name = this.doc.subpatches[inst]?.abstraction;
    const abs = name ? this.doc.abstractions[name] : undefined;
    if (!name || !abs) return;
    const def = JSON.parse(JSON.stringify(this.doc.subpatches[rel ? join(inst, rel) : inst])) as SubpatchDoc;
    if (!rel) {
      delete def.abstraction;
      for (const i of Object.values(def.inlets)) i.from = null;
    }
    abs.subpatches[rel] = def;
    for (const other of this.instancesOf(name)) {
      if (other === inst) continue;
      const target = rel ? join(other, rel) : other;
      const existing = this.doc.subpatches[target];
      const next = JSON.parse(JSON.stringify(def)) as SubpatchDoc;
      if (!rel && def.samples) {
        // Its slots are the abstraction's; which sample each plays stays the instance's own.
        next.samples = Object.fromEntries(Object.keys(def.samples).map((k) => [k, existing?.samples?.[k] ?? def.samples![k]]));
      }
      if (!rel) {
        // The interface follows the abstraction; the connections stay the instance's own.
        next.abstraction = name;
        for (const [k, v] of Object.entries(next.inlets)) v.from = existing?.inlets[k]?.from ?? null;
      }
      this.doc.subpatches[target] = next;
    }
  }

  /** The module a ref stands for: a module path, or a subpatch's (main or named) outlet. */
  moduleFor(ref: string, scope = ''): string {
    const r = resolveSource(this.doc, scope, ref);
    if (r.kind === 'silent') throw new ResolveError(`'${ref}' is an unconnected inlet`);
    return r.module;
  }

  // ── voices (used by the sequencer) ───────────────────────────────────────

  /** Bundle messages to start one voice; returns its node id. */
  voiceMessages(module: string, args: Record<string, number>): { id: number; msgs: [string, ...(string | number)[]][] } {
    const m = this.live.get(module);
    if (!m) throw new Error(`no module '${module}'`);
    if (m.compiled.kind !== 'voice' || m.group === null) throw new Error(`'${module}' is a ${m.compiled.kind} module; play() needs a voice module (use set() for others)`);
    const id = this.engine.nextNodeId();
    const wiring = Object.entries(m.wiring).flat();
    const controls = [INTERNAL.out, m.bus, ...(m.compiled.playhead ? [INTERNAL.playhead, m.meterId] : []), ...wiring, ...this.paramControls(m, args)];
    return { id, msgs: [['/s_new', m.defName, id, 1, m.group, ...controls]] };
  }

  hasParam(module: string, param: string): boolean {
    return Boolean(this.paramInfo(module, param));
  }

  nodeOf(module: string): number | null {
    const m = this.live.get(module);
    return m ? m.node ?? m.group : null;
  }

  // ── ordering ─────────────────────────────────────────────────────────────

  /** Order audio-group nodes so each module runs after the modules it reads. */
  private orderAudio() {
    const audio = [...this.live.values()].filter((m) => m.compiled.kind !== 'control');
    const names = new Set(audio.map((m) => m.path));
    const indeg = new Map<string, number>();
    const edges = new Map<string, string[]>();
    for (const m of audio) {
      indeg.set(m.path, 0);
      edges.set(m.path, []);
    }
    for (const m of audio) {
      for (const src of new Set(Object.values(m.sources))) {
        if (src && names.has(src) && src !== m.path) {
          edges.get(src)!.push(m.path);
          indeg.set(m.path, indeg.get(m.path)! + 1);
        }
      }
    }
    const order: string[] = [];
    const ready = audio.filter((m) => indeg.get(m.path) === 0).map((m) => m.path);
    const seen = new Set<string>();
    while (order.length < audio.length) {
      if (ready.length === 0) {
        // A feedback loop: InFeedback makes any order work; break it anywhere.
        const rest = audio.find((m) => !seen.has(m.path))!;
        ready.push(rest.path);
      }
      const n = ready.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      order.push(n);
      for (const d of edges.get(n)!) {
        indeg.set(d, indeg.get(d)! - 1);
        if (indeg.get(d)! <= 0 && !seen.has(d)) ready.push(d);
      }
    }
    const ids = order.map((n) => this.nodeOf(n)).filter((x): x is number => x !== null);
    if (ids.length > 1) this.engine.send('/n_order', 1, GROUPS.audio, ...ids);
  }

  // ── whole patch ──────────────────────────────────────────────────────────

  async clear(): Promise<void> {
    await this.exclusive(async () => {
      for (const name of [...this.live.keys()]) await this.removeModuleNow(name, { force: true });
      for (const name of Object.keys(this.doc.macros)) this.removeMacroNow(name);
      const title = this.doc.title;
      this.doc = emptyPatch();
      this.doc.title = title;
    });
    this.releaseSamples();
    this.changed();
  }

  /** Replace the whole running patch with a document. */
  async loadPatch(input: PatchDoc, opts: { keepHistory?: boolean } = {}): Promise<string[]> {
    if (!opts.keepHistory) this.checkpoint();
    const errors: string[] = [];
    await this.exclusive(async () => {
      for (const name of [...this.live.keys()]) await this.removeModuleNow(name, { force: true });
      for (const name of Object.keys(this.doc.macros)) this.removeMacroNow(name);
    });
    const next = migratePatch(clonePatch(input));
    this.doc = {
      ...emptyPatch(),
      title: next.title, bpm: next.bpm, master: next.master, notes: next.notes, routines: next.routines,
      subpatches: next.subpatches, abstractions: next.abstractions, samples: next.samples,
    };
    // The samples, before the modules that play them (all at once).
    if (this.bank) {
      await Promise.all(
        Object.entries(next.samples).map(([name, x]) =>
          this.bank!.ensure(x.src).catch((e) => {
            errors.push(`sample ${name}: ${(e as Error).message}`);
          }),
        ),
      );
    }
    this.releaseSamples();
    // Modules, in dependency order: retry the ones whose inputs aren't up yet.
    // (Docs for every module are in place first, so lexical lookups can see them.)
    const pending = new Map(Object.entries(next.modules));
    for (const [p, m] of pending) this.doc.modules[p] = { ...m };
    for (let round = 0; pending.size && round < 50; round++) {
      let progress = false;
      for (const [name, m] of [...pending]) {
        try {
          await this.exclusive(() => this.defineModuleNow(name, { ...m }, { fromAbstraction: true }));
          if (m.mute) this.setMonitor(name, { mute: true });
          pending.delete(name);
          progress = true;
        } catch (e) {
          if (!(e instanceof Error && /isn't running yet/.test(e.message))) {
            pending.delete(name);
            delete this.doc.modules[name];
            errors.push(`${name}: ${(e as Error).message}`);
          }
        }
      }
      if (!progress) break;
    }
    for (const name of pending.keys()) {
      delete this.doc.modules[name];
      errors.push(`${name}: circular or missing input()`);
    }
    for (const [name, mac] of Object.entries(next.macros)) {
      try {
        this.defineMacroNow(name, mac);
      } catch (e) {
        errors.push(`macro ${name}: ${(e as Error).message}`);
      }
    }
    for (const r of next.mods) {
      try {
        this.modulateNow(r.source, r.target, r.amount);
      } catch (e) {
        errors.push(`route ${r.source} → ${r.target}: ${(e as Error).message}`);
      }
    }
    const surface = next.surface.filter((s) => {
      try {
        this.resolveParamRef(s.ref);
        return true;
      } catch {
        return false;
      }
    });
    this.setSurface(surface);
    this.setMasterLevel(next.master.level);
    if (this.soloing()) this.syncMonitors();
    this.changed();
    return errors;
  }

  /**
   * Bring the running patch to a document, changing only what differs: a
   * module whose code is the same keeps its node (its knobs move in place),
   * new code crossfades in as a redefinition does, and what's gone fades out.
   * A listener's page follows the host's patch this way. Routines and the
   * tempo are the sequencer's (Sequencer.follow).
   */
  async reconcile(input: PatchDoc): Promise<string[]> {
    const next = migratePatch(clonePatch(input));
    const errors: string[] = [];
    await this.exclusive(async () => {
      const doc = this.doc;
      // What's gone, with its routes and its place on the surface.
      for (const path of [...this.live.keys()]) if (!next.modules[path]) await this.removeModuleNow(path, { force: true });
      for (const name of Object.keys(doc.macros)) if (!next.macros[name]) this.removeMacroNow(name);

      // The structure is data: subpatches (inputs re-point below), abstractions, samples (their buffers first).
      if (this.bank) {
        await Promise.all(
          Object.entries(next.samples).map(([name, x]) =>
            this.bank!.ensure(x.src).catch((e) => {
              errors.push(`sample ${name}: ${(e as Error).message}`);
            }),
          ),
        );
      }
      doc.subpatches = next.subpatches;
      doc.abstractions = next.abstractions;
      doc.samples = next.samples;
      doc.title = next.title;
      if (next.notes === undefined) delete doc.notes;
      else doc.notes = next.notes;

      // New modules and new code, in dependency order: retry the ones whose inputs aren't up yet.
      const pending = new Map(
        Object.entries(next.modules).filter(([path, m]) => {
          const live = this.live.get(path);
          return !live || live.compiled.kind !== m.kind || doc.modules[path]?.code !== m.code;
        }),
      );
      // New ones go in the document first, so lexical lookups can see them (as in loadPatch).
      for (const [path, m] of pending) if (!this.live.has(path)) doc.modules[path] = { ...m, params: { ...m.params } };
      for (let round = 0; pending.size && round < 50; round++) {
        let progress = false;
        for (const [path, m] of [...pending]) {
          const { kind, code, params, play, level, pan, fadeTime, description } = m;
          try {
            await this.defineModuleNow(path, { kind, code, params, play, level, pan, fadeTime, description }, { fromAbstraction: true });
            pending.delete(path);
            progress = true;
          } catch (e) {
            if (e instanceof Error && /isn't running yet/.test(e.message)) continue;
            pending.delete(path);
            if (!this.live.has(path)) delete doc.modules[path];
            errors.push(`${path}: ${(e as Error).message}`);
          }
        }
        if (!progress) break;
      }
      for (const path of pending.keys()) {
        if (!this.live.has(path)) delete doc.modules[path];
        errors.push(`${path}: circular or missing input()`);
      }

      // Inputs whose inlets or samples moved re-point (or recompile).
      await this.rewireAll();

      // Knobs and the mixer.
      let mixed = false;
      for (const [path, m] of Object.entries(next.modules)) if (this.live.has(path)) mixed = this.matchModule(path, m) || mixed;
      // A solo changes what every other strip's mute means.
      if (mixed || this.soloing()) this.syncMonitors();

      // Macros: a new one gets its bus; every one takes the document's settings.
      for (const [name, mac] of Object.entries(next.macros)) {
        try {
          const fresh = !this.macroBuses.has(name);
          if (fresh) this.defineMacroNow(name, {});
          const was = doc.macros[name];
          doc.macros[name] = { ...mac };
          if (fresh || was?.value !== mac.value || Boolean(was?.bipolar) !== Boolean(mac.bipolar)) this.writeMacro(name);
        } catch (e) {
          errors.push(`macro ${name}: ${(e as Error).message}`);
        }
      }

      // Routes: the ones that went, then the new and the changed (every source and target is up by now).
      const key = (r: { source: string; target: string }) => `${r.source}>${r.target}`;
      const wanted = new Map(next.mods.map((r, i) => [key(r), i]));
      const gone = doc.mods.filter((r) => !wanted.has(key(r)));
      if (gone.length) {
        doc.mods = doc.mods.filter((r) => wanted.has(key(r)));
        for (const target of new Set(gone.map((r) => r.target))) this.syncModSum(target);
      }
      for (const r of next.mods) {
        if (doc.mods.find((x) => key(x) === key(r))?.amount === r.amount) continue;
        try {
          this.modulateNow(r.source, r.target, r.amount);
        } catch (e) {
          errors.push(`route ${r.source} → ${r.target}: ${(e as Error).message}`);
        }
      }
      // In the document's order: it decides which slot each source takes.
      const sorted = [...doc.mods].sort((a, b) => (wanted.get(key(a)) ?? Infinity) - (wanted.get(key(b)) ?? Infinity));
      if (sorted.some((r, i) => r !== doc.mods[i])) {
        doc.mods = sorted;
        for (const target of new Set(sorted.map((r) => r.target))) this.syncModSum(target);
      }

      // The surface (what still resolves) and the master.
      doc.surface = next.surface.filter((s) => {
        try {
          this.resolveParamRef(s.ref);
          return true;
        } catch {
          return false;
        }
      });
      if (doc.master.level !== next.master.level) {
        doc.master.level = next.master.level;
        this.engine.send('/n_set', this.engine.masterNode, 'level', next.master.level);
      }
    });
    this.releaseSamples();
    this.changed();
    return errors;
  }

  /** A running module takes a document's knobs and settings; says whether its mixer strip changed. */
  private matchModule(path: string, want: ModuleDoc): boolean {
    const live = this.live.get(path)!;
    const d = this.doc.modules[path];
    const target = live.node ?? live.group;
    for (const p of live.compiled.params) {
      const v = want.params[p.name] ?? p.default;
      if (this.paramValue(path, p.name) === v) continue;
      if (v === p.default) delete d.params[p.name];
      else d.params[p.name] = v;
      const ms = this.modsums.get(`${path}.${p.name}`);
      if (ms) this.engine.send('/n_set', ms.node, 'pos', unmap(p.spec, v));
      else if (target !== null) this.engine.send('/n_set', target, p.name, v);
    }
    d.fadeTime = want.fadeTime;
    if (want.description === undefined) delete d.description;
    else d.description = want.description;
    const mixed = d.play !== want.play || d.level !== want.level || d.pan !== want.pan || d.mute !== want.mute || Boolean(d.solo) !== Boolean(want.solo);
    d.play = want.play;
    d.level = want.level;
    d.pan = want.pan;
    d.mute = want.mute;
    if (want.solo) d.solo = true;
    else delete d.solo;
    return mixed;
  }

  // ── listening ────────────────────────────────────────────────────────────

  /** Record a module's bus (or a subpatch's main outlet, or the master mix) and describe it. */
  async listen(target: string | null, seconds = 1): Promise<(AudioAnalysis | ControlAnalysis) & { module: string; rate: string }> {
    const secs = Math.min(4, Math.max(0.25, seconds));
    let bus: number, rate: 'audio' | 'control', channels: number, label: string;
    if (!target || target === 'master') {
      bus = this.engine.masterBus;
      rate = 'audio';
      channels = 2;
      label = 'master';
    } else {
      const r = resolveSource(this.doc, '', target);
      if (r.kind === 'silent') throw new Error(`'${target}' is an unconnected inlet`);
      const m = this.live.get(r.module);
      if (!m) throw new Error(`no module '${r.module}'`);
      bus = m.bus;
      rate = m.compiled.shape.rate;
      channels = m.compiled.shape.channels;
      if (r.output && m.compiled.shape.outputs[r.output]) {
        const [o, n] = m.compiled.shape.outputs[r.output];
        bus += o;
        channels = n;
      }
      label = r.module + (r.output ? `.${r.output}` : '');
    }
    const n = [1, 2, 4, 8].find((c) => c >= channels) ?? 8;
    const slot = this.engine.allocScope();
    const node = this.engine.nextNodeId();
    try {
      this.engine.send('/s_new', `patter_probe_${rate}_${n}`, node, 1, GROUPS.monitor, 'inBus', bus, 'scope', slot);
      const rec = await this.engine.recordScope(slot, secs);
      if (!rec) throw new Error('listen needs the SAB transport (cross-origin isolated page); no scope data arrived');
      const used = Math.min(channels, rec.channels);
      const frames = Math.floor(rec.data.length / rec.channels);
      const data = new Float32Array(frames * used);
      for (let i = 0; i < frames; i++) for (let c = 0; c < used; c++) data[i * used + c] = rec.data[i * rec.channels + c];
      const sr = this.engine.sampleRate;
      const result = rate === 'audio' ? analyseAudio(data, used, sr) : analyseControl(data, used, sr);
      return { module: label, rate, ...result };
    } finally {
      this.engine.send('/n_free', node);
      setTimeout(() => this.engine.freeScope(slot), 200);
    }
  }

  // ── reports ──────────────────────────────────────────────────────────────

  report(path: string, warnings: string[] = [], replaced = false): ModuleReport {
    const m = this.live.get(path)!;
    const shape = m.compiled.shape;
    const outs = Object.entries(shape.outputs).map(([k, [o, n]]) => (n === 1 ? `${k}@${o}` : `${k}@${o}..${o + n - 1}`));
    return {
      name: path,
      kind: m.compiled.kind,
      output: `${shape.channels}ch ${shape.rate}${outs.length ? ` (${outs.join(', ')})` : ''}`,
      params: m.compiled.params.map((p) => ({
        name: p.name,
        value: this.paramValue(path, p.name),
        min: p.spec.min,
        max: p.spec.max,
        warp: String(p.spec.warp),
        unit: p.spec.unit,
        rate: p.rate,
        modulated: this.modsums.has(`${path}.${p.name}`),
      })),
      inputs: m.compiled.refs.map((r) => ({ ref: r.ref, from: m.sources[r.control] ?? '(unconnected inlet: silence)' })),
      ...(m.compiled.samples.length ? { samples: m.compiled.samples.map((x) => ({ ref: x.ref, sample: m.samples[x.control] ?? '?' })) } : {}),
      warnings,
      ugens: m.compiled.data.ugens.length,
      replaced,
    };
  }

  specOf(ref: string): ControlSpec | undefined {
    try {
      const r = this.resolveParamRef(ref);
      return 'macro' in r ? { min: 0, max: 1, warp: 'lin' } : r.info.spec;
    } catch {
      return undefined;
    }
  }
}

function sourceModule(source: string): string | null {
  if (source.startsWith('macro:')) return null;
  const dot = source.indexOf('.');
  return dot < 0 ? source : source.slice(0, dot);
}

/** Replace an exact input('ref') / input("ref") in code. */
function replaceRef(code: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return code.replace(new RegExp(`(input\\(\\s*)(['"\`])${esc}\\2`, 'g'), `$1$2${to}$2`);
}
