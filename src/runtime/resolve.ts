// Name resolution in the patch hierarchy (lexical scoping, like Pd's local
// names): a ref is looked up among the modules and subpatches of its own
// scope, then among the scope's inlets. '../x' looks one level up, '/x' from
// the root, 'voice/env' reaches into a subpatch. A subpatch answers with its
// outlet (the first is the main one: 'voice' = 'voice.out'), an inlet with
// whatever feeds it in the parent. Every source ends at a module (or at an
// unconnected inlet, which is silence).

import { join, leafOf, parentOf, type PatchDoc } from './patch';

export type ResolvedSource =
  | { kind: 'module'; module: string; output?: string }
  | { kind: 'silent'; rate: 'audio' | 'control'; channels: number; via: string };

export type ResolvedParam =
  | { kind: 'param'; module: string; param: string }
  | { kind: 'macro'; macro: string };

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveError';
  }
}

interface ParsedRef {
  absolute: boolean;
  up: number;
  segments: string[];
  output?: string;
}

/** 'seq.gate' → seq + gate; '../voice/env.gate' → up 1, voice/env + gate; '/lfo' → absolute. */
export function parseRef(ref: string): ParsedRef {
  let rest = ref.trim();
  const absolute = rest.startsWith('/');
  if (absolute) rest = rest.slice(1);
  let up = 0;
  while (rest.startsWith('../')) {
    up++;
    rest = rest.slice(3);
  }
  const segments = rest.split('/');
  const last = segments[segments.length - 1];
  const dot = last.indexOf('.');
  let output: string | undefined;
  if (dot >= 0) {
    output = last.slice(dot + 1);
    segments[segments.length - 1] = last.slice(0, dot);
  }
  if (segments.some((s) => !s)) throw new ResolveError(`bad reference '${ref}'`);
  return { absolute, up, segments, output };
}

function climb(scope: string, up: number, ref: string): string {
  let s = scope;
  for (let i = 0; i < up; i++) {
    if (!s) throw new ResolveError(`'${ref}' goes above the top of the patch`);
    s = parentOf(s);
  }
  return s;
}

/** Names visible in a scope, for error messages. */
export function visibleNames(doc: PatchDoc, scope: string): string[] {
  const names = new Set<string>();
  for (const p of [...Object.keys(doc.modules), ...Object.keys(doc.subpatches)]) {
    if (parentOf(p) === scope && p !== scope) names.add(leafOf(p));
  }
  for (const i of Object.keys(doc.subpatches[scope]?.inlets ?? {})) names.add(`${i} (inlet)`);
  return [...names].sort();
}

function notFound(doc: PatchDoc, scope: string, name: string, ref: string): never {
  const where = scope ? `subpatch '${scope}'` : 'the top level';
  const seen = visibleNames(doc, scope);
  const hint = scope ? ` — to read something from outside, give '${scope}' an inlet (subpatch configure inlets: { ${name}: { from: '<source>' } }) or reach out with '../${name}'` : '';
  throw new ResolveError(`'${ref}': no '${name}' in ${where}${seen.length ? ` (there: ${seen.join(', ')})` : ''}${hint}`);
}

/** Where a signal ref, written in `scope`, comes from. */
export function resolveSource(doc: PatchDoc, scope: string, ref: string, seen: Set<string> = new Set()): ResolvedSource {
  const key = `${scope}|${ref}`;
  if (seen.has(key)) throw new ResolveError(`'${ref}' resolves in a loop (an inlet fed by itself?)`);
  seen.add(key);
  const r = parseRef(ref);
  let cur = r.absolute ? '' : climb(scope, r.up, ref);
  for (let i = 0; i < r.segments.length; i++) {
    const seg = r.segments[i];
    const last = i === r.segments.length - 1;
    const p = join(cur, seg);
    if (doc.modules[p]) {
      if (!last) throw new ResolveError(`'${ref}': '${p}' is a module, not a subpatch`);
      return { kind: 'module', module: p, output: r.output };
    }
    const sub = doc.subpatches[p];
    if (sub) {
      if (!last) {
        cur = p;
        continue;
      }
      const { outlets, candidates } = outletsOf(doc, p);
      const names = Object.keys(outlets);
      if (names.length === 0) {
        throw new ResolveError(
          candidates?.length
            ? `'${ref}': subpatch '${p}' has no outlets, and ${candidates.join(', ')} could each be its output — declare one (subpatch configure outlets)`
            : `'${ref}': subpatch '${p}' has no outlets (and nothing inside to read)`,
        );
      }
      const outlet = r.output ?? names[0];
      const inner = outlets[outlet];
      if (inner === undefined) throw new ResolveError(`'${ref}': subpatch '${p}' has no outlet '${outlet}' (outlets: ${names.join(', ')})`);
      return resolveSource(doc, p, inner, seen);
    }
    // An inlet of the scope we started in.
    const inlet = i === 0 && !r.absolute && r.up === 0 ? doc.subpatches[cur]?.inlets[seg] : undefined;
    if (inlet) {
      if (inlet.from === null) return { kind: 'silent', rate: inlet.rate, channels: inlet.channels, via: `${cur}.${seg}` };
      const from = r.output && !inlet.from.includes('.') ? `${inlet.from}.${r.output}` : inlet.from;
      return resolveSource(doc, parentOf(cur), from, seen);
    }
    notFound(doc, cur, seg, ref);
  }
  throw new ResolveError(`bad reference '${ref}'`);
}

/** Find a macro by name, from `scope` outwards. */
export function resolveMacro(doc: PatchDoc, scope: string, name: string): string | null {
  if (name.startsWith('/')) return doc.macros[name.slice(1)] ? name.slice(1) : null;
  let s = scope;
  for (;;) {
    const p = join(s, name);
    if (doc.macros[p]) return p;
    if (!s) return null;
    s = parentOf(s);
  }
}

/**
 * A param ref, written in `scope`: 'filter.cutoff', 'voice/filter.cutoff',
 * 'voice.cutoff' (a subpatch control), 'macro:dark'.
 */
export function resolveParam(doc: PatchDoc, scope: string, ref: string, seen: Set<string> = new Set()): ResolvedParam {
  if (ref.startsWith('macro:')) {
    const m = resolveMacro(doc, scope, ref.slice(6));
    if (!m) throw new ResolveError(`no macro '${ref.slice(6)}'${scope ? ` visible from '${scope}'` : ''}`);
    return { kind: 'macro', macro: m };
  }
  const key = `${scope}|${ref}`;
  if (seen.has(key)) throw new ResolveError(`'${ref}': controls refer to each other in a loop`);
  seen.add(key);
  const dot = ref.lastIndexOf('.');
  if (dot <= 0) throw new ResolveError(`'${ref}' should be "module.param"`);
  const pathPart = ref.slice(0, dot);
  const param = ref.slice(dot + 1);
  const r = parseRef(pathPart);
  if (r.output !== undefined) throw new ResolveError(`bad param reference '${ref}'`);
  let cur = r.absolute ? '' : climb(scope, r.up, ref);
  for (let i = 0; i < r.segments.length; i++) {
    const p = join(cur, r.segments[i]);
    const last = i === r.segments.length - 1;
    if (doc.modules[p]) {
      if (!last) throw new ResolveError(`'${ref}': '${p}' is a module, not a subpatch`);
      return { kind: 'param', module: p, param };
    }
    const sub = doc.subpatches[p];
    if (!sub) notFound(doc, cur, r.segments[i], ref);
    if (!last) {
      cur = p;
      continue;
    }
    const inner = sub.controls[param];
    if (inner === undefined) {
      const names = Object.keys(sub.controls);
      throw new ResolveError(`'${ref}': subpatch '${p}' has no control '${param}'${names.length ? ` (controls: ${names.join(', ')})` : ' (it exposes no controls; reach in with a path, e.g. ' + `'${p}/<module>.<param>')`}`);
    }
    return resolveParam(doc, p, inner, seen);
  }
  throw new ResolveError(`bad param reference '${ref}'`);
}

const INPUT_REF = /input\(\s*(['"`])([^'"`]+)\1/g;

/** The input() refs written in a module's code (a textual scan, good enough for structure). */
export function refsInCode(code: string): string[] {
  return [...code.matchAll(INPUT_REF)].map((m) => m[2]);
}

/**
 * A subpatch's outlets. Without declared outlets it has an implicit main
 * outlet 'out': the one child nothing else inside reads (audio before
 * control), when there is exactly one.
 */
export function outletsOf(doc: PatchDoc, path: string): { outlets: Record<string, string>; implicit: boolean; candidates?: string[] } {
  const sub = doc.subpatches[path];
  if (!sub) return { outlets: {}, implicit: false };
  if (Object.keys(sub.outlets).length) return { outlets: sub.outlets, implicit: false };
  const { modules, subpatches } = childrenOf(doc, path);
  const read = new Set<string>();
  const note = (ref: string | null) => {
    if (!ref) return;
    try {
      const r = parseRef(ref);
      if (!r.absolute && r.up === 0) read.add(r.segments[0]);
    } catch {
      /* not a ref */
    }
  };
  for (const m of modules) for (const ref of refsInCode(doc.modules[m].code)) note(ref);
  for (const s of subpatches) for (const inl of Object.values(doc.subpatches[s].inlets)) note(inl.from);
  const sinks = [...modules, ...subpatches].map(leafOf).filter((n) => !read.has(n));
  const audible = sinks.filter((n) => doc.modules[join(path, n)]?.kind !== 'control');
  const pick = audible.length ? audible : sinks;
  return pick.length === 1 ? { outlets: { out: pick[0] }, implicit: true } : { outlets: {}, implicit: true, candidates: pick };
}

/** Direct children (modules and subpatches) of a scope. */
export function childrenOf(doc: PatchDoc, scope: string): { modules: string[]; subpatches: string[] } {
  const isChild = (p: string) => p !== scope && parentOf(p) === scope;
  return {
    modules: Object.keys(doc.modules).filter(isChild),
    subpatches: Object.keys(doc.subpatches).filter(isChild),
  };
}

/** The nearest enclosing abstraction instance of a path ('' if none). */
export function instanceRootOf(doc: PatchDoc, path: string): string {
  for (let s = parentOf(path); s; s = parentOf(s)) {
    if (doc.subpatches[s]?.abstraction) return s;
  }
  return '';
}
