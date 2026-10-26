// Semantic comparison of SynthDefs: each side-effecting UGen (no outputs) is
// hashed as a Merkle DAG of what feeds it, order-independent, with algebraic
// rewrites sclang applies (or we skip) normalised away:
//   MulAdd(a,b,c) ≡ a*b + c;  Sum3/Sum4 ≡ +;  a - b ≡ a + neg(b);
//   + and * are n-ary and commutative; neg(neg(x)) ≡ x.

import type { SynthDefData } from '../src/sc/synthdef';
import { BINARY_OPS, UNARY_OPS } from '../src/sc/ops';

const BIN_NAME = Object.fromEntries(Object.entries(BINARY_OPS).map(([k, v]) => [v, k]));
const UN_NAME = Object.fromEntries(Object.entries(UNARY_OPS).map(([k, v]) => [v, k]));
const RATE = ['ir', 'kr', 'ar', 'dr'];
const COMMUTATIVE = new Set(['min', 'max', '==', '!=', 'hypot', 'sumsqr', 'absdif', 'sqrsum']);

type Expr = { op: string; args: Expr[]; rate?: string } | { k: number } | { ctl: string };

function key(e: Expr): string {
  if ('k' in e) return `k(${e.k})`;
  if ('ctl' in e) return `ctl(${e.ctl})`;
  return `${e.op}${e.rate ? `@${e.rate}` : ''}(${e.args.map(key).join(',')})`;
}

export interface Canon {
  roots: string[];
  params: Record<string, number>;
}

export function canonicalize(def: SynthDefData): Canon {
  const paramName = (index: number): string => {
    let best = '';
    let bestIdx = -1;
    for (const p of def.paramNames) {
      if (p.index <= index && p.index > bestIdx) {
        best = p.name;
        bestIdx = p.index;
      }
    }
    return index === bestIdx ? best : `${best}[${index - bestIdx}]`;
  };

  const memo = new Map<string, Expr>();
  const f32 = (x: number) => Math.fround(x);

  const input = ([u, o]: [number, number]): Expr => (u === -1 ? { k: f32(def.constants[o]) } : node(u, o));

  function plus(args: Expr[], rate: string): Expr {
    const flat: Expr[] = [];
    for (const a of args) {
      if ('op' in a && a.op === '+') flat.push(...a.args);
      else if ('k' in a && a.k === 0) continue;
      else flat.push(a);
    }
    if (flat.length === 1) return flat[0];
    flat.sort((x, y) => key(x).localeCompare(key(y)));
    return { op: '+', args: flat, rate };
  }

  function times(args: Expr[], rate: string): Expr {
    const flat: Expr[] = [];
    for (const a of args) {
      if ('op' in a && a.op === '*') flat.push(...a.args);
      else if ('k' in a && a.k === 1) continue;
      else flat.push(a);
    }
    if (flat.length === 1) return flat[0];
    flat.sort((x, y) => key(x).localeCompare(key(y)));
    return { op: '*', args: flat, rate };
  }

  function neg(a: Expr, rate: string): Expr {
    if ('op' in a && a.op === 'neg') return a.args[0];
    if ('k' in a) return { k: f32(-a.k) };
    return { op: 'neg', args: [a], rate };
  }

  function node(ui: number, oi: number): Expr {
    const id = `${ui}:${oi}`;
    const hit = memo.get(id);
    if (hit) return hit;
    const u = def.ugens[ui];
    const rate = RATE[u.rate];
    let e: Expr;
    const ins = () => u.inputs.map(input);
    if (u.name === 'Control' || u.name === 'TrigControl' || u.name === 'AudioControl' || u.name === 'LagControl') {
      e = { ctl: `${paramName(u.specialIndex + oi)}:${u.name === 'Control' ? rate : u.name}` };
    } else if (u.name === 'BinaryOpUGen') {
      const op = BIN_NAME[u.specialIndex] ?? `bin${u.specialIndex}`;
      const [a, b] = ins();
      if (op === '+') e = plus([a, b], rate);
      else if (op === '*') e = times([a, b], rate);
      else if (op === '-') e = plus([a, neg(b, rate)], rate);
      else {
        const args = [a, b];
        if (COMMUTATIVE.has(op)) args.sort((x, y) => key(x).localeCompare(key(y)));
        e = { op, args, rate };
      }
    } else if (u.name === 'UnaryOpUGen') {
      const op = UN_NAME[u.specialIndex] ?? `un${u.specialIndex}`;
      const [a] = ins();
      e = op === 'neg' ? neg(a, rate) : { op, args: [a], rate };
    } else if (u.name === 'MulAdd') {
      const [a, b, c] = ins();
      e = plus([times([a, b], rate), c], rate);
    } else if (u.name === 'Sum3' || u.name === 'Sum4') {
      e = plus(ins(), rate);
    } else {
      e = { op: `${u.name}#${u.specialIndex}[${oi}/${u.outputs.length}]`, args: ins(), rate };
    }
    memo.set(id, e);
    return e;
  }

  const roots: string[] = [];
  def.ugens.forEach((u, i) => {
    if (u.outputs.length === 0) roots.push(key(node(i, 0)));
  });
  roots.sort();

  const params: Record<string, number> = {};
  def.paramNames.forEach((p, i) => {
    const next = def.paramNames.map((q) => q.index).filter((x) => x > p.index).sort((a, b) => a - b)[0] ?? def.params.length;
    for (let j = p.index; j < next; j++) params[j === p.index ? p.name : `${p.name}[${j - p.index}]`] = f32(def.params[j]);
    void i;
  });
  return { roots, params };
}
