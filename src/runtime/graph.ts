// Textual pictures of the running system, for the agent (and the user):
// the patch as a Mermaid flowchart, and one module's compiled UGen graph as
// a netlist in the spirit of sclang's SynthDef.dumpUGens.

import { catalog } from '../sc/scope';
import { BINARY_OPS, UNARY_OPS } from '../sc/ops';
import type { SynthDefData } from '../sc/synthdef';
import type { Runtime } from './runtime';
import { INTERNAL } from './module-def';
import { join, leafOf, parentOf, relativeTo, within } from './patch';
import { childrenOf, outletsOf, resolveSource } from './resolve';

const BIN_SYMBOL = Object.fromEntries(Object.entries(BINARY_OPS).map(([k, v]) => [v, k]));
const UN_NAME = Object.fromEntries(Object.entries(UNARY_OPS).map(([k, v]) => [v, k]));
const RATE = ['ir', 'kr', 'ar', 'dr'];

const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
const id = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
const short = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v)}` : `${Math.round(v * 1000) / 1000}`);

// ── one level of the hierarchy ──────────────────────────────────────────────

export interface LevelNode {
  /**
   * Full path for modules and subpatches; 'macro:<path>' for macros;
   * 'inlet:<name>' / 'outlet:<name>' for the scope's own ports;
   * 'ext:<path>' for something outside the scope that feeds it directly.
   */
  id: string;
  label: string;
  kind: 'audio' | 'control' | 'voice' | 'subpatch' | 'inlet' | 'outlet' | 'macro' | 'external';
  /** Subpatches: the abstraction they are an instance of. */
  abstraction?: string;
  /** Short facts shown under the name. */
  sub: string;
  description?: string;
  /** Subpatches: inlet and outlet names, in order (an implicit main outlet counts). */
  inlets?: string[];
  outlets?: string[];
  /** What flows out of it, for laying out control above audio. */
  rate: 'audio' | 'control';
  /** The module whose level the node's meter shows. */
  meter?: string;
}

export interface LevelEdge {
  from: string;
  to: string;
  kind: 'audio' | 'control' | 'mod';
  /** A subpatch's outlet the cable leaves from / inlet it enters. */
  fromPort?: string;
  toPort?: string;
  label?: string;
}

/**
 * One scope as a graph, the way a Pd/Max patcher window shows one level: its
 * direct children (a subpatch is one box however much is inside), the scope's
 * own inlets and outlets, and the cables between them, attached to the ports
 * they go through. Cables deeper inside a child are folded into it.
 */
export function levelGraph(rt: Runtime, scope: string): { nodes: LevelNode[]; edges: LevelEdge[] } {
  const doc = rt.doc;
  const here = doc.subpatches[scope];
  const { modules, subpatches } = childrenOf(doc, scope);
  const nodes: LevelNode[] = [];
  const rateOf = (module: string | null | undefined): 'audio' | 'control' => (module && rt.module(module)?.compiled.shape.rate === 'control' ? 'control' : 'audio');
  const moduleOf = (s: string, ref: string): string | null => {
    try {
      const r = resolveSource(doc, s, ref);
      return r.kind === 'module' ? r.module : null;
    } catch {
      return null;
    }
  };
  const shapeText = (p: string) => {
    const s = rt.module(p)?.compiled.shape;
    if (!s) return '';
    const outs = Object.keys(s.outputs);
    return `${s.channels}ch${outs.length ? ` · ${outs.join(' ')}` : ''}`;
  };

  // The scope's inlets, and which outside module each one carries in.
  const inletOf = new Map<string, string>();
  for (const [name, inl] of Object.entries(here?.inlets ?? {})) {
    const src = inl.from ? moduleOf(parentOf(scope), inl.from) : null;
    if (src && !inletOf.has(src)) inletOf.set(src, `inlet:${name}`);
    nodes.push({ id: `inlet:${name}`, label: name, kind: 'inlet', sub: inl.from ? `← ${inl.from}` : 'unconnected', rate: inl.rate, meter: src ?? undefined, description: inl.description });
  }
  for (const m of Object.keys(doc.macros).filter((k) => parentOf(k) === scope)) {
    const d = doc.macros[m];
    nodes.push({ id: `macro:${m}`, label: d.label ?? leafOf(m), kind: 'macro', sub: `macro ${short(d.value)}`, rate: 'control', description: d.description });
  }
  for (const p of modules) {
    const d = doc.modules[p];
    nodes.push({ id: p, label: leafOf(p), kind: d.kind, sub: shapeText(p), rate: rateOf(p), meter: p, description: d.description });
  }
  // Each child subpatch: its ports, and which module each port carries.
  const childIn = new Map<string, Map<string, string>>();
  const childOut = new Map<string, Map<string, string>>();
  for (const p of subpatches) {
    const sp = doc.subpatches[p];
    const outs = outletsOf(doc, p);
    const ins = new Map<string, string>();
    for (const [name, inl] of Object.entries(sp.inlets)) {
      const src = inl.from ? moduleOf(scope, inl.from) : null;
      if (src && !ins.has(src)) ins.set(src, name);
    }
    const outMap = new Map<string, string>();
    for (const [name, ref] of Object.entries(outs.outlets)) {
      const m = moduleOf(p, ref);
      if (m && !outMap.has(m)) outMap.set(m, name);
    }
    childIn.set(p, ins);
    childOut.set(p, outMap);
    const main = moduleOf(scope, leafOf(p));
    const inside = Object.keys(doc.modules).filter((k) => within(k, p)).length;
    nodes.push({
      id: p,
      label: leafOf(p),
      kind: 'subpatch',
      abstraction: sp.abstraction,
      sub: `${inside} module${inside === 1 ? '' : 's'}`,
      description: sp.description,
      inlets: Object.keys(sp.inlets),
      outlets: Object.keys(outs.outlets),
      rate: rateOf(main),
      meter: main ?? undefined,
    });
  }
  const scopeOuts = scope ? outletsOf(doc, scope) : { outlets: {}, implicit: false };
  for (const [name, ref] of Object.entries(scopeOuts.outlets)) {
    const m = moduleOf(scope, ref);
    nodes.push({ id: `outlet:${name}`, label: name, kind: 'outlet', sub: `→ ${ref}${scopeOuts.implicit ? ' (implicit)' : ''}`, rate: rateOf(m), meter: m ?? undefined });
  }

  /** The node at this level that stands for a path (null when it's outside the scope). */
  const visible = (p: string): string | null => {
    if (!within(p, scope) || p === scope) return null;
    return join(scope, relativeTo(p, scope).split('/')[0]);
  };
  const ids = new Set(nodes.map((n) => n.id));
  /** Something outside that comes in without an inlet: show where it's from. */
  const external = (p: string): string => {
    const id = `ext:${p}`;
    if (!ids.has(id)) {
      ids.add(id);
      const isMacro = p.startsWith('macro:');
      nodes.push({ id, label: p, kind: 'external', sub: isMacro ? 'outside macro' : 'outside', rate: isMacro ? 'control' : rateOf(p), meter: isMacro ? undefined : p });
    }
    return id;
  };

  const edges = new Map<string, LevelEdge>();
  const add = (e: LevelEdge) => {
    if (e.from === e.to) return;
    const k = `${e.from}|${e.fromPort ?? ''}>${e.to}|${e.toPort ?? ''}>${e.kind}>${e.label ?? ''}`;
    if (!edges.has(k)) edges.set(k, e);
  };
  for (const p of Object.keys(doc.modules)) {
    const to = visible(p);
    const live = rt.module(p);
    if (!to || !live) continue;
    for (const src of new Set(Object.values(live.sources))) {
      if (!src || within(src, to)) continue;
      const inside = visible(src);
      const from = inside ?? inletOf.get(src) ?? external(src);
      add({
        from,
        to,
        kind: rateOf(src),
        fromPort: inside && inside !== src ? childOut.get(inside)?.get(src) : undefined,
        toPort: to !== p ? childIn.get(to)?.get(src) : undefined,
      });
    }
  }
  for (const [name, ref] of Object.entries(scopeOuts.outlets)) {
    const m = moduleOf(scope, ref);
    if (!m) continue;
    const inside = visible(m);
    const from = inside ?? inletOf.get(m);
    if (from) add({ from, to: `outlet:${name}`, kind: rateOf(m), fromPort: inside && inside !== m ? childOut.get(inside)?.get(m) : undefined });
  }
  for (const r of doc.mods) {
    const tModule = r.target.slice(0, r.target.lastIndexOf('.'));
    const to = visible(tModule);
    if (!to) continue;
    let from: string | null;
    if (r.source.startsWith('macro:')) {
      const m = r.source.slice(6);
      from = parentOf(m) === scope ? `macro:${m}` : visible(m) ?? external(r.source);
    } else {
      const src = r.source.split('.')[0];
      from = visible(src) ?? inletOf.get(src) ?? external(src);
    }
    if (!from || from === to) continue;
    const param = r.target.slice(r.target.lastIndexOf('.') + 1);
    const inner = to === tModule ? '' : `${relativeTo(tModule, to)}.`;
    add({ from, to, kind: 'mod', label: `${inner}${param} ${r.amount > 0 ? '+' : ''}${short(r.amount)}` });
  }
  return { nodes, edges: [...edges.values()] };
}

// ── Mermaid ─────────────────────────────────────────────────────────────────

/**
 * The patch (or one subpatch) as a Mermaid flowchart: subpatches as nested
 * subgraphs down to `depth`, deeper ones folded into single nodes.
 */
export function patchMermaid(rt: Runtime, opts: { path?: string; depth?: number } = {}): string {
  const doc = rt.doc;
  const root = opts.path ?? '';
  const depth = opts.depth ?? 8;
  const lines = ['flowchart LR'];
  const label = (p: string) => {
    const live = rt.module(p);
    const shape = live?.compiled.shape;
    const outs = shape && Object.keys(shape.outputs).length ? ` · ${Object.keys(shape.outputs).join('/')}` : '';
    const params = (live?.compiled.params ?? [])
      .filter((x) => x.rate !== 'trigger')
      .slice(0, 4)
      .map((x) => `${x.name}=${short(rt.paramValue(p, x.name))}`)
      .join(' ');
    return `${leafOf(p)} · ${doc.modules[p].kind} ${shape ? `${shape.channels}ch` : ''}${outs}${params ? `<br/>${params}` : ''}`;
  };
  const levelOf = (p: string) => (root ? relativeTo(p, root) : p).split('/').length;
  /** The node that stands for a module at the chosen depth (a folded subpatch, or the module). */
  const shown = (p: string): string => {
    const rel = root ? relativeTo(p, root) : p;
    const segs = rel.split('/');
    return segs.length > depth ? join(root, segs.slice(0, depth).join('/')) : p;
  };
  const emit = (scope: string, indent: string) => {
    const { modules, subpatches } = childrenOf(doc, scope);
    for (const m of Object.keys(doc.macros).filter((k) => parentOf(k) === scope)) {
      lines.push(`${indent}macro_${id(m)}{{${q(`${doc.macros[m].label ?? leafOf(m)} ${short(doc.macros[m].value)}`)}}}`);
    }
    for (const p of modules) {
      const shape = doc.modules[p].kind === 'control' ? ['([', '])'] : ['[', ']'];
      lines.push(`${indent}${id(p)}${shape[0]}${q(label(p))}${shape[1]}`);
    }
    for (const sp of subpatches) {
      const s = doc.subpatches[sp];
      const title = `${leafOf(sp)}${s.abstraction ? ` : ${s.abstraction}` : ''}`;
      if (levelOf(sp) >= depth) {
        lines.push(`${indent}${id(sp)}[[${q(`${title} · subpatch`)}]]`);
        continue;
      }
      lines.push(`${indent}subgraph ${id(sp)}[${q(title)}]`);
      lines.push(`${indent}  direction LR`);
      emit(sp, `${indent}  `);
      lines.push(`${indent}end`);
    }
  };
  emit(root, '  ');
  lines.push('  master((master))');
  const seen = new Set<string>();
  const edge = (line: string) => {
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  };
  for (const p of Object.keys(doc.modules)) {
    if (!within(p, root)) continue;
    const live = rt.module(p);
    for (const src of new Set(Object.values(live?.sources ?? {}))) {
      if (!src) continue;
      const a = within(src, root) ? shown(src) : src;
      const b = shown(p);
      if (a === b) continue;
      if (!within(src, root)) lines.splice(1, 0, `  ${id(src)}[${q(`${src} (outside)`)}]`);
      edge(`  ${id(a)} ${rt.module(src)?.compiled.shape.rate === 'control' ? '-.->' : '-->'} ${id(b)}`);
    }
    const d = doc.modules[p];
    if (d.kind !== 'control' && d.play) edge(`  ${id(shown(p))} ==>${d.mute ? '|muted|' : d.level !== 1 ? `|${short(d.level)}|` : ''} master`);
  }
  for (const r of doc.mods) {
    const tModule = r.target.slice(0, r.target.lastIndexOf('.'));
    if (!within(tModule, root)) continue;
    const srcPath = r.source.startsWith('macro:') ? r.source.slice(6) : r.source.split('.')[0];
    const from = r.source.startsWith('macro:') ? `macro_${id(srcPath)}` : id(within(srcPath, root) ? shown(srcPath) : srcPath);
    const param = r.target.slice(r.target.lastIndexOf('.') + 1);
    edge(`  ${from} -. ${q(`${param} ×${short(r.amount)}`)} .-> ${id(shown(tModule))}`);
  }
  return lines.join('\n');
}

/** Execution order inside the engine (groups and synths), from SuperSonic's node mirror. */
export function nodeOrder(rt: Runtime): string {
  const nodes = new Map<number, string>();
  for (const [name] of Object.entries(rt.doc.modules)) {
    const n = rt.nodeOf(name);
    if (n !== null) nodes.set(n, name);
  }
  const tree = rt.engine.sonic.getTree();
  const out: string[] = [];
  const walk = (node: { id: unknown; type: string; defName: string; children: unknown[] } | null, depth: number) => {
    if (!node) return;
    const nid = typeof node.id === 'number' ? node.id : -1;
    const mod = nodes.get(nid);
    const what = node.type === 'group' ? `group ${nid}${mod ? ` (${mod} voices)` : ''}` : `${node.defName}${mod ? ` ← ${mod}` : ''}`;
    out.push(`${'  '.repeat(depth)}${what}`);
    for (const c of node.children as (typeof node)[]) walk(c, depth + 1);
  };
  walk(tree.root as never, 0);
  return out.join('\n');
}

/** One module's compiled UGen graph, one line per UGen, inputs labelled by argument name. */
export function moduleNetlist(rt: Runtime, module: string): string {
  const live = rt.module(module);
  if (!live) throw new Error(`no module '${module}'`);
  return netlist(live.compiled.data, `${module} (${live.defName})`);
}

export function netlist(def: SynthDefData, title = def.name): string {
  const paramName = (index: number) => {
    let best = '';
    let bestIdx = -1;
    for (const p of def.paramNames) if (p.index <= index && p.index > bestIdx) { best = p.name; bestIdx = p.index; }
    return index === bestIdx ? best : `${best}[${index - bestIdx}]`;
  };
  const isControl = (name: string) => name === 'Control' || name === 'TrigControl' || name === 'AudioControl' || name === 'LagControl';
  const ref = (u: number, o: number): string => {
    if (u === -1) return short(def.constants[o]);
    const src = def.ugens[u];
    if (isControl(src.name)) {
      const n = paramName(src.specialIndex + o);
      return n.startsWith(INTERNAL.inPrefix) ? `bus(${n.slice(INTERNAL.inPrefix.length)})` : n;
    }
    return src.outputs.length > 1 ? `#${u}[${o}]` : `#${u}`;
  };
  const lines = [`${title}: ${def.ugens.length} UGens`];
  def.ugens.forEach((u, i) => {
    if (isControl(u.name)) return;
    const rate = RATE[u.rate];
    const ins = u.inputs.map(([a, b]) => ref(a, b));
    let body: string;
    if (u.name === 'BinaryOpUGen') body = `${BIN_SYMBOL[u.specialIndex] ?? `op${u.specialIndex}`}(${ins.join(', ')})`;
    else if (u.name === 'UnaryOpUGen') body = `${UN_NAME[u.specialIndex] ?? `op${u.specialIndex}`}(${ins.join(', ')})`;
    else {
      const spec = catalog.ugens[u.name] ?? Object.values(catalog.ugens).find((s) => s.serverName === u.name);
      const m = spec?.methods[rate === 'ar' ? 'ar' : rate === 'kr' ? 'kr' : rate === 'ir' ? 'ir' : 'new'] ?? spec?.methods.new;
      body = `${u.name}.${rate}(${labelInputs(m?.inputs, ins).join(', ')})`;
    }
    const outs = u.outputs.length > 1 ? `  → ${u.outputs.length} outs` : '';
    lines.push(`#${i} ${body}${outs}`);
  });
  const params = def.paramNames.filter((p) => !p.name.startsWith('__')).map((p) => `${p.name}=${short(def.params[p.index])}`);
  if (params.length) lines.push(`params: ${params.join(', ')}`);
  return lines.join('\n');
}

type InputSpecLike = Record<string, unknown>;

/** Name each input after its sclang argument; a trailing array/env argument takes the rest. */
function labelInputs(specs: InputSpecLike[] | undefined, ins: string[]): string[] {
  if (!specs) return ins;
  const out: string[] = [];
  let i = 0;
  for (let k = 0; k < specs.length && i < ins.length; k++) {
    const sp = specs[k];
    const last = k === specs.length - 1;
    if ('arg' in sp) out.push(`${sp.arg}: ${ins[i++]}`);
    else if ('const' in sp || 'arrayLength' in sp || 'stringLength' in sp || 'ugen' in sp) i++;
    else if (last && 'env' in sp) out.push(`${sp.env}: ${envText(ins.slice(i))}`), (i = ins.length);
    else if (last) out.push(`${(sp.arrayArg ?? sp.spec ?? sp.string ?? 'inputs') as string}: [${ins.slice(i).join(', ')}]`), (i = ins.length);
    else return ins; // a variadic argument in the middle: fall back to positions
  }
  if (i < ins.length) out.push(...ins.slice(i));
  return out;
}

const SHAPES = ['step', 'lin', 'exp', 'sin', 'wel', 'curve', 'sqr', 'cub', 'hold'];

/** [init, n, release, loop, (level, time, shape, curve)…] → "0 →1 @0.01(-4) →0 @0.5(-4) release@1" */
function envText(v: string[]): string {
  const [init, n, rel, loop] = v;
  const segs: string[] = [];
  for (let s = 0; s < Number(n); s++) {
    const [level, time, shape, curve] = v.slice(4 + s * 4, 8 + s * 4);
    const sh = SHAPES[Number(shape)] ?? shape;
    segs.push(`→${level} @${time}${sh === 'curve' ? `(${curve})` : sh === 'lin' ? '' : `(${sh})`}`);
  }
  const extra = [rel !== '-99' ? `release node ${rel}` : '', loop !== '-99' ? `loop node ${loop}` : ''].filter(Boolean).join(', ');
  return `Env(${init} ${segs.join(' ')}${extra ? `; ${extra}` : ''})`;
}
