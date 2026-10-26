// The names DSL code can use: every UGen class in the catalog (as callable
// objects with .ar/.kr/.ir/.new), the hand-built ones, Env, and helpers.

import catalogJson from './ugen-catalog.json';
import { makeUGenClass, type Catalog, type UGenSpec } from './catalog';
import { $bin, $call, $un } from './dsl';
import { Env } from './env';
import { mix, setSignalRanges } from './methods';
import { SPECIAL_CLASSES } from './special';
import { GraphError, Sig, bin, madd, un, type SigLike } from './ugen';
import { UNARY_OPS, type UnaryOp } from './ops';

export const catalog = catalogJson as unknown as Catalog;

setSignalRanges(Object.values(catalog.ugens).map((u) => [u.serverName, u.signalRange] as [string, 'bipolar' | 'unipolar' | undefined]));

type AnyFn = (...a: unknown[]) => unknown;

function callable(name: string, spec: UGenSpec): AnyFn & Record<string, AnyFn> {
  const methods = makeUGenClass(name, spec);
  const direct = methods.new ?? methods.ar ?? methods.kr ?? methods.ir;
  const f = ((...a: unknown[]) => {
    if (!direct) throw new GraphError(`${name} has no constructor`);
    return direct(...a);
  }) as AnyFn & Record<string, AnyFn>;
  Object.assign(f, methods);
  return f;
}

/** UGen classes by sclang class name. */
export const ugenClasses: Record<string, AnyFn & Record<string, AnyFn>> = {};
for (const [name, spec] of Object.entries(catalog.ugens)) {
  if (spec.internal) continue;
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) continue;
  ugenClasses[name] = callable(name, spec);
}
Object.assign(ugenClasses, SPECIAL_CLASSES);

// Env.kr / Env.ar (sclang 3.10+): env.kr(doneAction, gate, timeScale, mul, add)
Object.assign(Env.prototype, {
  kr(this: Env, doneAction: SigLike = 0, gate: SigLike = 1, timeScale: SigLike = 1, mul: SigLike = 1, add: SigLike = 0) {
    return madd(ugenClasses.EnvGen.kr(this, gate, 1, 0, timeScale, doneAction) as SigLike, mul, add);
  },
  ar(this: Env, doneAction: SigLike = 0, gate: SigLike = 1, timeScale: SigLike = 1, mul: SigLike = 1, add: SigLike = 0) {
    return madd(ugenClasses.EnvGen.ar(this, gate, 1, 0, timeScale, doneAction) as SigLike, mul, add);
  },
});

const num = (x: unknown) => typeof x === 'number';

/** Free functions (sclang's `rrand(a, b)`, `midicps(x)`, …). */
const helpers: Record<string, unknown> = {
  inf: Infinity,
  pi: Math.PI,
  twopi: Math.PI * 2,
  Env,
  fill: (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i)),
  dup: (x: unknown, n = 2) => Array.from({ length: n }, (_, i) => (typeof x === 'function' ? (x as AnyFn)(i) : x)),
  sum: (a: SigLike) => mix(a),
  rrand: (lo: number, hi: number) => (Number.isInteger(lo) && Number.isInteger(hi) ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo + Math.random() * (hi - lo)),
  exprand: (lo: number, hi: number) => lo * Math.exp(Math.log(hi / lo) * Math.random()),
  rand: (x = 1) => Math.random() * x,
  rand2: (x = 1) => (Math.random() * 2 - 1) * x,
  coin: (p = 0.5) => Math.random() < p,
  choose: (a: unknown[]) => a[Math.floor(Math.random() * a.length)],
  max: (a: SigLike, b: SigLike) => (num(a) && num(b) ? Math.max(a as number, b as number) : bin('max', a, b)),
  min: (a: SigLike, b: SigLike) => (num(a) && num(b) ? Math.min(a as number, b as number) : bin('min', a, b)),
  pow: (a: SigLike, b: SigLike) => bin('pow', a, b),
  clip: (x: SigLike, lo: SigLike = -1, hi: SigLike = 1) => (x instanceof Sig ? x.clip(lo, hi) : $call(x, 'clip', [lo, hi])),
  // the circle of SC conveniences
  Sig,
  $bin, $un, $call,
};

for (const op of Object.keys(UNARY_OPS) as UnaryOp[]) {
  if (!(op in helpers)) helpers[op] = (x: SigLike) => un(op, x);
}

export function baseScope(): Record<string, unknown> {
  return { ...ugenClasses, ...helpers };
}

/** Short reference text for one UGen (shown to the agent on request). */
export function describeUGen(name: string): string | null {
  const spec = catalog.ugens[name];
  if (!spec) return SPECIAL_CLASSES[name] ? `${name}: built from other UGens (see the patch-language guide)` : null;
  const lines = [`${name} — ${spec.summary ?? ''}`.trim()];
  for (const [m, ms] of Object.entries(spec.methods)) {
    if (!ms) continue;
    const args = ms.args.map((a) => (a.default === null || a.default === undefined ? a.name : `${a.name}=${JSON.stringify(a.default)}`));
    if (ms.mulAdd) args.push('mul=1', 'add=0');
    const outs = typeof ms.numOutputs === 'number' ? (ms.numOutputs === 1 ? '' : ` → ${ms.numOutputs} outputs`) : ` → outputs from ${JSON.stringify(ms.numOutputs)}`;
    lines.push(`  ${name}.${m}(${args.join(', ')})${outs}`);
  }
  if (spec.argDocs) {
    for (const [k, v] of Object.entries(spec.argDocs)) lines.push(`    ${k}: ${v}`);
  }
  if (spec.signalRange === 'unipolar') lines.push('  output range: unipolar (0..1)');
  return lines.join('\n');
}
