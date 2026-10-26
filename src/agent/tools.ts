// The agent's tools: how it reaches the substrate. Each tool validates its
// input (tool inputs stream eagerly, so the API doesn't), runs against the
// runtime/sequencer, and returns compact JSON — including anything the engine
// complained about while it ran.

import type { Engine } from '../engine/engine';
import type { Runtime } from '../runtime/runtime';
import type { Sequencer } from '../seq/sequencer';
import { describeUGen, catalog } from '../sc/scope';
export { TOOL_DEFS } from './tool-defs';
import { ModuleCompileError } from '../runtime/module-def';
import { moduleNetlist, nodeOrder, patchMermaid } from '../runtime/graph';
import { join, leafOf, parentOf, within } from '../runtime/patch';
import { childrenOf, outletsOf, resolveSource } from '../runtime/resolve';

export interface ToolContext {
  runtime: Runtime;
  seq: Sequencer;
  engine: Engine;
  /** True while the user has the sound stopped (⌘.). */
  isStopped?: () => boolean;
}

class InputError extends Error {}

// ── tiny validation helpers ─────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function obj(x: unknown, where = 'input'): Obj {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new InputError(`${where} must be an object`);
  return x as Obj;
}
function str(o: Obj, k: string, opt = false): string | undefined {
  const v = o[k];
  if (v === undefined || v === null) {
    if (opt) return undefined;
    throw new InputError(`'${k}' is required`);
  }
  if (typeof v !== 'string') throw new InputError(`'${k}' must be a string`);
  return v;
}
function num(o: Obj, k: string, opt = false): number | undefined {
  const v = o[k];
  if (v === undefined || v === null) {
    if (opt) return undefined;
    throw new InputError(`'${k}' is required`);
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new InputError(`'${k}' must be a finite number`);
  return v;
}
function bool(o: Obj, k: string): boolean | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new InputError(`'${k}' must be true or false`);
  return v;
}
function arr(o: Obj, k: string, opt = false): unknown[] | undefined {
  const v = o[k];
  if (v === undefined || v === null) {
    if (opt) return undefined;
    throw new InputError(`'${k}' is required`);
  }
  if (!Array.isArray(v)) throw new InputError(`'${k}' must be an array`);
  return v;
}
function record(o: Obj, k: string): Obj | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  return obj(v, k);
}
function strOrNullRecord(o: Obj, k: string): Record<string, string | null> | undefined {
  const r = record(o, k);
  if (!r) return undefined;
  for (const [kk, vv] of Object.entries(r)) {
    if (vv !== null && typeof vv !== 'string') throw new InputError(`'${k}.${kk}' must be a string or null`);
  }
  return r as Record<string, string | null>;
}
function numRecord(o: Obj, k: string): Record<string, number> | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  const r = obj(v, k);
  for (const [kk, vv] of Object.entries(r)) {
    if (typeof vv !== 'number' || !Number.isFinite(vv)) throw new InputError(`'${k}.${kk}' must be a number`);
  }
  return r as Record<string, number>;
}

// ── execution ───────────────────────────────────────────────────────────────

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

function json(x: unknown): string {
  return JSON.stringify(x, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10000) / 10000 : v));
}

export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const since = performance.now();
  try {
    const result = await execute(name, obj(rawInput), ctx);
    // Give the engine a moment to complain about what we just sent.
    await new Promise((r) => setTimeout(r, 60));
    const engineLog = ctx.engine.recent(since, ['fail', 'error']).map((e) => e.text);
    const payload = engineLog.length ? { ...((result as object) ?? {}), engine_errors: engineLog } : result;
    return { content: typeof payload === 'string' ? payload : json(payload), isError: false };
  } catch (e) {
    const err = e as Error;
    const prefix = e instanceof InputError ? 'invalid input: ' : e instanceof ModuleCompileError ? 'compile error: ' : '';
    return { content: `${prefix}${err.message}`, isError: true };
  }
}

async function execute(name: string, input: Obj, ctx: ToolContext): Promise<unknown> {
  const { runtime: rt, seq } = ctx;
  switch (name) {
    case 'define_module': {
      const moduleName = str(input, 'name')!;
      const kind = str(input, 'kind')! as 'audio' | 'control' | 'voice';
      if (!['audio', 'control', 'voice'].includes(kind)) throw new InputError("kind must be 'audio', 'control' or 'voice'");
      rt.checkpoint();
      const report = await rt.defineModule(moduleName, {
        kind,
        code: str(input, 'code')!,
        params: numRecord(input, 'params'),
        play: bool(input, 'play'),
        level: num(input, 'level', true),
        fadeTime: num(input, 'fade_time', true),
        description: str(input, 'description', true),
      });
      return report;
    }
    case 'remove_module': {
      rt.checkpoint();
      await rt.removeModule(str(input, 'name')!, { force: bool(input, 'force') });
      return { removed: input.name };
    }
    case 'set_params': {
      const updates = arr(input, 'updates')!;
      const done: string[] = [];
      for (const u of updates) {
        const o = obj(u, 'update');
        const target = str(o, 'target')!;
        const value = num(o, 'value')!;
        if (!target.startsWith('macro:') && !target.includes('.')) throw new InputError(`target '${target}' should be "module.param", "subpatch.control" or "macro:name"`);
        rt.setByRef(target, value);
        done.push(`${target}=${value}`);
      }
      return { set: done };
    }
    case 'modulate': {
      const routes = arr(input, 'routes')!;
      rt.checkpoint();
      const done: string[] = [];
      for (const r of routes) {
        const o = obj(r, 'route');
        const source = str(o, 'source')!;
        const target = str(o, 'target')!;
        const amount = num(o, 'amount')!;
        rt.modulate(source, target, amount);
        done.push(amount === 0 ? `removed ${source} → ${target}` : `${source} → ${target} × ${amount}`);
      }
      return { routes: done, all: rt.doc.mods };
    }
    case 'define_macro': {
      const targets = arr(input, 'targets')!.map((t) => {
        const o = obj(t, 'target');
        return { target: str(o, 'target')!, amount: num(o, 'amount')! };
      });
      rt.checkpoint();
      rt.defineMacro(str(input, 'name')!, {
        label: str(input, 'label', true),
        value: num(input, 'value', true),
        bipolar: bool(input, 'bipolar'),
        description: str(input, 'description', true),
        targets,
      });
      return { macro: input.name, routes: rt.doc.mods.filter((m) => m.source === `macro:${input.name}`) };
    }
    case 'remove_macro': {
      rt.checkpoint();
      rt.removeMacro(str(input, 'name')!);
      return { removed: input.name };
    }
    case 'define_routine': {
      const status = seq.define(str(input, 'name')!, str(input, 'code')!, {
        quant: num(input, 'quant', true),
        play: bool(input, 'play'),
      });
      const description = str(input, 'description', true);
      if (description) rt.doc.routines[status.name].description = description;
      return { ...status, startsAtBeat: Math.round(status.nextBeat * 100) / 100, nowBeat: Math.round(seq.beatNow() * 100) / 100 };
    }
    case 'routine_control': {
      const n = str(input, 'name')!;
      const action = str(input, 'action')!;
      if (n === '*') {
        if (action !== 'stop') throw new InputError('only "stop" works with "*"');
        seq.stopAll();
        return { stopped: 'all' };
      }
      if (action === 'play') seq.play(n);
      else if (action === 'stop') seq.stop(n);
      else if (action === 'remove') seq.remove(n);
      else throw new InputError("action must be 'play', 'stop' or 'remove'");
      return seq.status(n) ?? { removed: n };
    }
    case 'set_tempo': {
      seq.setBpm(num(input, 'bpm')!);
      return { bpm: seq.bpm };
    }
    case 'mix': {
      const module = str(input, 'module')!;
      if (module === 'master') {
        const level = num(input, 'level', true);
        if (level !== undefined) rt.setMasterLevel(level);
        return { master: rt.doc.master };
      }
      const target = rt.moduleFor(module);
      rt.setMonitor(target, { play: bool(input, 'play'), level: num(input, 'level', true), pan: num(input, 'pan', true), mute: bool(input, 'mute') });
      const d = rt.doc.modules[target];
      return { module: target, play: d.play, level: d.level, pan: d.pan, mute: d.mute };
    }
    case 'expose_controls': {
      const items = arr(input, 'items')!.map((i) => {
        const o = obj(i, 'item');
        return { ref: str(o, 'ref')!, label: str(o, 'label', true), group: str(o, 'group', true) };
      });
      rt.setSurface(items);
      return { surface: items.map((i) => i.ref) };
    }
    case 'listen': {
      if (ctx.isStopped?.()) {
        throw new InputError('the sound is stopped: the user pressed stop (⌘.). Changes still apply, but nothing plays; ask them to press play before you listen.');
      }
      const module = str(input, 'module')!;
      return await rt.listen(module === 'master' ? null : module, num(input, 'seconds', true) ?? 1);
    }
    case 'inspect': {
      const what = str(input, 'what')!;
      if (what === 'patch') return summarizePatch(ctx, true);
      if (what === 'module') {
        const n = str(input, 'name')!;
        const doc = rt.doc.modules[n];
        if (!doc) throw new InputError(`no module '${n}'`);
        return { ...rt.report(n), code: doc.code, play: doc.play, level: doc.level, routes: rt.doc.mods.filter((r) => r.target.startsWith(`${n}.`) || r.source.split('.')[0] === n), readBy: rt.dependents(n) };
      }
      if (what === 'subpatch') return describeSubpatch(rt, str(input, 'name')!);
      if (what === 'routines') return { bpm: seq.bpm, beat: Math.round(seq.beatNow() * 100) / 100, routines: seq.list().map((r) => ({ ...r, code: rt.doc.routines[r.name]?.code })) };
      if (what === 'log') return { log: ctx.engine.log.slice(-40).map((e) => `[${e.kind}] ${e.text}`) };
      if (what === 'tree') return { tree: ctx.engine.sonic.getTree().root };
      throw new InputError(`unknown 'what': ${what}`);
    }
    case 'graph': {
      const module = str(input, 'module', true);
      if (module) return moduleNetlist(rt, rt.moduleFor(module));
      const path = str(input, 'path', true);
      if (path && !rt.doc.subpatches[path]) throw new InputError(`no subpatch '${path}'`);
      const mermaid = patchMermaid(rt, { path, depth: num(input, 'depth', true) });
      if (path) return mermaid;
      return `${mermaid}\n\n%% execution order\n${nodeOrder(rt).split('\n').map((l) => `%% ${l}`).join('\n')}`;
    }
    case 'trace': {
      const module = rt.moduleFor(str(input, 'module')!);
      const node = rt.nodeOf(module);
      if (node === null) throw new InputError(`no running node for '${module}'`);
      const lines = await ctx.engine.trace(node);
      return lines.length ? lines.slice(0, 400).join('\n') : 'no trace output arrived (is the node running?)';
    }
    case 'subpatch': {
      const action = str(input, 'action')!;
      const path = str(input, 'path')!;
      rt.checkpoint();
      if (action === 'group') {
        const members = arr(input, 'members')!.map(String);
        return await rt.groupIntoSubpatch(parentOf(path), leafOf(path), members, str(input, 'description', true));
      }
      if (action === 'ungroup') return await rt.ungroup(path);
      if (action === 'remove') {
        await rt.removeSubpatch(path, { force: bool(input, 'force') });
        return { removed: path };
      }
      if (action === 'duplicate') return await rt.duplicate(path, str(input, 'to', true));
      if (action === 'configure') {
        const inlets = record(input, 'inlets');
        const parsed = inlets && Object.fromEntries(Object.entries(inlets).map(([k, v]) => [k, parseInlet(k, v)]));
        const r = await rt.defineSubpatch(path, {
          description: str(input, 'description', true),
          inlets: parsed,
          outlets: strOrNullRecord(input, 'outlets'),
          controls: strOrNullRecord(input, 'controls'),
        });
        return { ...describeSubpatch(rt, path), ...(r.warnings.length ? { warnings: r.warnings } : {}) };
      }
      throw new InputError("action must be 'group', 'ungroup', 'configure', 'remove' or 'duplicate'");
    }
    case 'abstraction': {
      const action = str(input, 'action')!;
      if (action === 'list') return listAbstractions(rt);
      rt.checkpoint();
      if (action === 'save') {
        const name = str(input, 'name')!;
        const abs = await rt.saveAbstraction(str(input, 'path')!, name, str(input, 'description', true));
        return { saved: name, modules: Object.keys(abs.modules), instances: rt.instancesOf(name) };
      }
      if (action === 'instantiate') {
        return await rt.instantiate(str(input, 'name')!, str(input, 'path')!, { inlets: strOrNullRecord(input, 'inlets'), params: numRecord(input, 'params') });
      }
      if (action === 'detach') {
        const path = str(input, 'path')!;
        await rt.detach(path);
        return { detached: path };
      }
      throw new InputError("action must be 'save', 'instantiate', 'detach' or 'list'");
    }
    case 'ugen_reference': {
      const names = (arr(input, 'names')!).map(String).slice(0, 12);
      return names.map((n) => describeUGen(n) ?? `${n}: not available in this engine${suggest(n)}`).join('\n\n');
    }
    case 'clear_patch': {
      if (bool(input, 'confirm') !== true) throw new InputError('confirm must be true');
      rt.checkpoint();
      seq.stopAll();
      seq.clear();
      await rt.clear();
      return { cleared: true };
    }
    case 'annotate': {
      const title = str(input, 'title', true);
      const notes = str(input, 'notes', true);
      rt.checkpoint();
      if (title !== undefined) rt.setTitle(title);
      if (notes !== undefined) rt.setNotes(notes);
      return { title: rt.doc.title, notes: rt.doc.notes };
    }
  }
  throw new InputError(`unknown tool '${name}'`);
}

function suggest(name: string): string {
  const lower = name.toLowerCase();
  const near = Object.keys(catalog.ugens).filter((n) => n.toLowerCase().includes(lower.slice(0, 4))).slice(0, 6);
  return near.length ? ` (similar: ${near.join(', ')})` : '';
}

function parseInlet(name: string, v: unknown) {
  if (v === null) return null;
  if (typeof v === 'string') return { from: v };
  const o = obj(v, `inlets.${name}`);
  const rate = o.rate;
  if (rate !== undefined && rate !== 'audio' && rate !== 'control') throw new InputError(`inlets.${name}.rate must be "audio" or "control"`);
  if (o.channels !== undefined && (typeof o.channels !== 'number' || o.channels < 1 || o.channels > 16)) throw new InputError(`inlets.${name}.channels must be 1..16`);
  if (o.from !== undefined && o.from !== null && typeof o.from !== 'string') throw new InputError(`inlets.${name}.from must be a ref or null`);
  return {
    from: o.from as string | null | undefined,
    rate: rate as 'audio' | 'control' | undefined,
    channels: o.channels as number | undefined,
    description: typeof o.description === 'string' ? o.description : undefined,
  };
}

/** One subpatch: its interface (and what the inlets resolve to), what's inside, who reads it. */
function describeSubpatch(rt: Runtime, path: string) {
  const doc = rt.doc;
  const s = doc.subpatches[path];
  if (!s) throw new InputError(`no subpatch '${path}'`);
  const { modules, subpatches } = childrenOf(doc, path);
  const outs = outletsOf(doc, path);
  const resolves = (from: string | null) => {
    if (!from) return '(unconnected: silence)';
    try {
      const r = resolveSource(doc, parentOf(path), from);
      return r.kind === 'module' ? r.module + (r.output ? `.${r.output}` : '') : '(unconnected: silence)';
    } catch (e) {
      return `(error: ${(e as Error).message})`;
    }
  };
  const readers = rt.moduleNames().filter((m) => !within(m, path) && Object.values(rt.module(m)?.sources ?? {}).some((src) => src && within(src, path)));
  return {
    path,
    ...(s.abstraction ? { instanceOf: s.abstraction, otherInstances: rt.instancesOf(s.abstraction).filter((p) => p !== path) } : {}),
    ...(s.description ? { description: s.description } : {}),
    inlets: Object.fromEntries(Object.entries(s.inlets).map(([k, v]) => [k, { from: v.from, resolves: resolves(v.from), shape: `${v.channels}ch ${v.rate}` }])),
    outlets: outs.implicit
      ? Object.keys(outs.outlets).length
        ? { ...outs.outlets, note: 'implicit: the one module inside nothing else reads' }
        : { note: `none declared; candidates: ${outs.candidates?.join(', ') || 'nothing inside'}` }
      : outs.outlets,
    controls: s.controls,
    modules: Object.fromEntries(modules.map((m) => [leafOf(m), doc.modules[m].kind])),
    ...(subpatches.length ? { subpatches: subpatches.map(leafOf) } : {}),
    ...(readers.length ? { readBy: readers } : {}),
  };
}

function listAbstractions(rt: Runtime) {
  return Object.fromEntries(
    Object.entries(rt.doc.abstractions).map(([name, a]) => {
      const root = a.subpatches[''] ?? { inlets: {}, outlets: {}, controls: {} };
      const nested = Object.entries(a.subpatches).filter(([r, sp]) => r && sp.abstraction).map(([r, sp]) => `${r}: ${sp.abstraction}`);
      return [
        name,
        {
          ...(a.description ? { description: a.description } : {}),
          inlets: Object.fromEntries(Object.entries(root.inlets).map(([k, v]) => [k, `${v.channels}ch ${v.rate}`])),
          outlets: root.outlets,
          controls: root.controls,
          modules: Object.keys(a.modules),
          ...(nested.length ? { nested } : {}),
          instances: rt.instancesOf(name),
        },
      ];
    }),
  );
}

/** A compact description of the running patch, for the agent. */
export function summarizePatch(ctx: ToolContext, full = false): unknown {
  const { runtime: rt, seq } = ctx;
  const doc = rt.doc;
  const modules = Object.entries(doc.modules).map(([name, d]) => {
    const live = rt.module(name);
    const shape = live?.compiled.shape;
    return {
      name,
      kind: d.kind,
      out: shape ? `${shape.channels}ch${Object.keys(shape.outputs).length ? ` ${Object.keys(shape.outputs).join('/')}` : ''}` : '?',
      // A ref that reads a sibling shows as written; one that goes elsewhere shows where.
      inputs: (live?.compiled.refs ?? []).map((r) => {
        const src = live!.sources[r.control];
        if (!src) return `${r.ref}→(unconnected)`;
        return join(parentOf(name), r.ref.split('.')[0]) === src ? r.ref : `${r.ref}→${src}`;
      }),
      params: Object.fromEntries((live?.compiled.params ?? []).map((p) => [p.name, Math.round(rt.paramValue(name, p.name) * 1000) / 1000])),
      ...(d.kind !== 'control' ? { play: d.play, level: d.level } : {}),
      ...(d.description ? { desc: d.description } : {}),
      ...(full ? { code: d.code } : {}),
    };
  });
  const subpatches = Object.entries(doc.subpatches).map(([path, sp]) => ({
    path,
    ...(sp.abstraction ? { instanceOf: sp.abstraction } : {}),
    ...(sp.description ? { desc: sp.description } : {}),
    ...(Object.keys(sp.inlets).length ? { inlets: Object.fromEntries(Object.entries(sp.inlets).map(([k, v]) => [k, v.from])) } : {}),
    outlets: outletsOf(doc, path).outlets,
    ...(Object.keys(sp.controls).length ? { controls: sp.controls } : {}),
  }));
  const abstractions = Object.entries(doc.abstractions).map(([name, a]) => `${name}${a.description ? ` (${a.description})` : ''}: ${rt.instancesOf(name).join(', ') || 'no instances'}`);
  return {
    title: doc.title,
    bpm: Math.round(seq.bpm * 100) / 100,
    modules,
    ...(subpatches.length ? { subpatches } : {}),
    ...(abstractions.length ? { abstractions } : {}),
    mods: doc.mods.map((m) => `${m.source} → ${m.target} × ${m.amount}`),
    macros: Object.fromEntries(Object.entries(doc.macros).map(([k, v]) => [k, { value: Math.round(v.value * 1000) / 1000, label: v.label }])),
    routines: seq.list().map((r) => `${r.name}: ${r.playing ? 'playing' : 'stopped'}${r.error ? ` (error: ${r.error})` : ''}`),
    surface: doc.surface.map((s) => s.ref),
  };
}
