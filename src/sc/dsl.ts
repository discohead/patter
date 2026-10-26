// The patch language: JavaScript with sclang's signal semantics.
//
// Source is parsed with acorn and rewritten so that arithmetic and
// comparisons on signals build UGens (`a * b` → $bin('*', a, b)), method calls
// work on numbers and arrays as they do in sclang (`[a, b].tanh()`,
// `(60).midicps()`), and loops can't hang the page. The rewritten code runs
// as a function body with the DSL names in scope.

import { parse, type Node } from 'acorn';
import { generate } from 'astring';
import { Sig, bin, describe, un, type SigLike } from './ugen';
import { BINARY_OPS, UNARY_OPS, type BinaryOp, type UnaryOp } from './ops';
import { mix } from './methods';

export class DslError extends Error {
  constructor(message: string, readonly line?: number, readonly column?: number) {
    super(message);
    this.name = 'DslError';
  }
}

// ── Transform ───────────────────────────────────────────────────────────────

const OPERATORS: Record<string, string> = {
  '+': '+', '-': '-', '*': '*', '/': '/', '%': '%', '**': 'pow',
  '<': '<', '>': '>', '<=': '<=', '>=': '>=',
};

type AnyNode = Node & Record<string, unknown>;

const id = (name: string) => ({ type: 'Identifier', name });
const lit = (value: string | number) => ({ type: 'Literal', value });
const call = (callee: string, args: unknown[]) => ({ type: 'CallExpression', callee: id(callee), arguments: args, optional: false });

function guardLoopBody(body: AnyNode): AnyNode {
  const guard = { type: 'ExpressionStatement', expression: call('$guard', []) };
  if (body.type === 'BlockStatement') {
    return { ...body, body: [guard, ...(body.body as unknown[])] } as AnyNode;
  }
  return { type: 'BlockStatement', body: [guard, body] } as unknown as AnyNode;
}

function rewrite(node: unknown, opts: TransformOptions): unknown {
  if (Array.isArray(node)) return node.map((n) => rewrite(n, opts));
  if (!node || typeof node !== 'object') return node;
  const n = node as AnyNode;
  if (typeof n.type !== 'string') return node;

  // Rewrite children first.
  const out: AnyNode = { ...n };
  for (const key of Object.keys(n)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const v = n[key];
    if (v && typeof v === 'object') out[key] = rewrite(v, opts) as never;
  }

  if (opts.operators) {
    if (out.type === 'BinaryExpression' && OPERATORS[out.operator as string]) {
      return call('$bin', [lit(OPERATORS[out.operator as string]), out.left, out.right]);
    }
    if (out.type === 'UnaryExpression' && out.operator === '-') {
      const arg = out.argument as AnyNode;
      if (arg.type === 'Literal' && typeof arg.value === 'number') return out;
      return call('$un', [lit('neg'), arg]);
    }
    if (out.type === 'AssignmentExpression') {
      const op = (out.operator as string).slice(0, -1);
      if ((out.operator as string).endsWith('=') && OPERATORS[op] && out.operator !== '==' ) {
        return { ...out, operator: '=', right: call('$bin', [lit(OPERATORS[op]), out.left, out.right]) };
      }
    }
    if (out.type === 'CallExpression' && !out.optional) {
      const callee = out.callee as AnyNode;
      if (callee.type === 'MemberExpression' && !callee.optional && (callee.object as AnyNode).type !== 'Super') {
        const prop = callee.computed ? callee.property : lit((callee.property as AnyNode).name as string);
        return call('$call', [callee.object, prop, { type: 'ArrayExpression', elements: out.arguments }]);
      }
    }
  }

  if (opts.loopGuard) {
    if (['WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement'].includes(out.type)) {
      return { ...out, body: guardLoopBody(out.body as AnyNode) };
    }
  }
  if (opts.lineMarkers && (out.type === 'BlockStatement' || out.type === 'Program')) {
    return { ...out, body: markLines(out.body as AnyNode[], opts.generator ? 1 : 0) };
  }
  return out;
}

export interface TransformOptions {
  operators: boolean;
  loopGuard: boolean;
  /** Turn a trailing expression statement into `return`. */
  autoReturn: boolean;
  /** Call $at(line) before each statement so runtime errors can say where. */
  lineMarkers?: boolean;
  /** The source is a generator body (routines: `yield beats`). */
  generator?: boolean;
}

const GEN_NAME = '__routine__';

function markLines(body: AnyNode[], lineOffset: number): AnyNode[] {
  const out: AnyNode[] = [];
  for (const stmt of body) {
    const line = (stmt.loc as { start: { line: number } } | undefined)?.start.line;
    if (line && stmt.type !== 'FunctionDeclaration') {
      out.push({ type: 'ExpressionStatement', expression: call('$at', [lit(line - lineOffset)]) } as unknown as AnyNode);
    }
    out.push(stmt);
  }
  return out;
}

function isMarker(stmt: AnyNode): boolean {
  const e = stmt.expression as AnyNode | undefined;
  return e?.type === 'CallExpression' && ((e.callee as AnyNode).name === '$at');
}

export function transform(source: string, opts: TransformOptions): string {
  let ast: AnyNode;
  const text = opts.generator ? `function* ${GEN_NAME}() {\n${source}\n}` : source;
  try {
    ast = parse(text, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: false,
      locations: true,
    }) as unknown as AnyNode;
  } catch (e) {
    const err = e as SyntaxError & { loc?: { line: number; column: number } };
    const line = err.loc ? err.loc.line - (opts.generator ? 1 : 0) : undefined;
    const msg = err.message.replace(/\s*\(\d+:\d+\)$/, '');
    throw new DslError(`syntax error${line ? ` at line ${line}` : ''}: ${msg}`, line, err.loc?.column);
  }
  const program = rewrite(ast, opts) as AnyNode;
  const body = program.body as AnyNode[];
  if (opts.autoReturn && body.length) {
    const last = body[body.length - 1];
    if (last.type === 'ExpressionStatement' && !isMarker(last)) {
      body[body.length - 1] = { type: 'ReturnStatement', argument: last.expression } as unknown as AnyNode;
    }
  }
  return generate(program as never);
}

// ── Runtime helpers the rewritten code calls ────────────────────────────────

const isSigValue = (x: unknown): boolean =>
  x instanceof Sig || (Array.isArray(x) && x.some((e) => e instanceof Sig || Array.isArray(e) || typeof e === 'number'));

function jsOp(op: string, a: any, b: any): unknown {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    case 'pow': return a ** b;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
  }
  throw new DslError(`unknown operator ${op}`);
}

export function $bin(op: string, a: unknown, b: unknown): unknown {
  if (typeof a === 'number' && typeof b === 'number') return jsOp(op, a, b);
  if (typeof a === 'string' || typeof b === 'string') return jsOp(op, a, b);
  const A = typeof a === 'boolean' ? Number(a) : a;
  const B = typeof b === 'boolean' ? Number(b) : b;
  if (isSigValue(A) || isSigValue(B)) {
    if (!(op in BINARY_OPS)) throw new DslError(`operator ${op} is not defined for signals`);
    return bin(op as BinaryOp, A as SigLike, B as SigLike);
  }
  return jsOp(op, A, B);
}

export function $un(op: string, a: unknown): unknown {
  if (typeof a === 'number') return -a;
  if (a instanceof Sig || Array.isArray(a)) return un(op as UnaryOp, a as SigLike);
  return -(a as number);
}

const SIG_PROTO = Sig.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;

/** sclang collection methods DSL code tends to reach for. */
const ARRAY_METHODS: Record<string, (arr: unknown[], ...a: any[]) => unknown> = {
  sum: (arr) => mix(arr as SigLike),
  mean: (arr) => bin('/', mix(arr as SigLike), arr.length),
  dup: (arr, n = 2) => Array.from({ length: n }, () => arr),
  flop: (arr) => {
    const rows = arr.map((r) => (Array.isArray(r) ? r : [r]));
    const n = Math.max(...rows.map((r) => r.length));
    return Array.from({ length: n }, (_, i) => rows.map((r) => r[i % r.length]));
  },
  choose: (arr) => arr[Math.floor(Math.random() * arr.length)],
  scramble: (arr) => [...arr].sort(() => Math.random() - 0.5),
  collect: (arr, f) => arr.map(f),
  do: (arr, f) => { arr.forEach(f); return arr; },
  select: (arr, f) => arr.filter(f),
  reject: (arr, f) => arr.filter((x, i) => !f(x, i)),
  wrapAt: (arr, i) => arr[((i % arr.length) + arr.length) % arr.length],
  clipAt: (arr, i) => arr[Math.max(0, Math.min(arr.length - 1, i))],
  foldAt: (arr, i) => {
    const n = arr.length;
    if (n < 2) return arr[0];
    const p = 2 * (n - 1);
    const m = ((i % p) + p) % p;
    return arr[m < n ? m : p - m];
  },
  clump: (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n)),
  rotate: (arr, n = 1) => arr.map((_, i) => arr[(((i - n) % arr.length) + arr.length) % arr.length]),
  mirror: (arr) => [...arr, ...arr.slice(0, -1).reverse()],
  normalizeSum: (arr) => {
    const s = (arr as number[]).reduce((a, b) => a + b, 0);
    return (arr as number[]).map((x) => x / s);
  },
  size: (arr) => arr.length,
};

export function $call(obj: unknown, name: unknown, args: unknown[]): unknown {
  if (obj === null || obj === undefined) {
    throw new DslError(`can't call .${String(name)}() on ${obj}`);
  }
  const key = name as string;
  const native = (obj as Record<string, unknown>)[key];
  if (typeof native === 'function') return (native as (...a: unknown[]) => unknown).apply(obj, args);
  if (Array.isArray(obj)) {
    if (ARRAY_METHODS[key]) return ARRAY_METHODS[key](obj, ...args);
    if (typeof SIG_PROTO[key] === 'function') return obj.map((x) => $call(x, key, args));
  }
  if (typeof obj === 'number' && typeof SIG_PROTO[key] === 'function') {
    return SIG_PROTO[key].apply(obj, args);
  }
  if (typeof obj === 'function' && key === 'dup') {
    const n = (args[0] as number) ?? 2;
    return Array.from({ length: n }, (_, i) => (obj as (i: number) => unknown)(i));
  }
  if (native !== undefined) throw new DslError(`${describe(obj)}.${key} is not a function`);
  throw new DslError(`${describe(obj)} has no method .${key}()`);
}

export class LoopGuard {
  count = 0;
  constructor(readonly limit = 200_000) {}
  readonly guard = () => {
    if (++this.count > this.limit) {
      throw new DslError(`a loop ran more than ${this.limit} times — is it infinite? (in a routine, every loop needs a yield)`);
    }
  };
}

// ── Evaluation ──────────────────────────────────────────────────────────────

export interface CompiledFunction {
  run: (scope: Record<string, unknown>) => unknown;
  source: string;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Compile DSL source to a function of a scope object (names become locals). */
export function compileBody(source: string, scopeNames: string[], opts: TransformOptions): CompiledFunction {
  const js = transform(source, opts);
  const names = scopeNames.filter((n) => IDENT.test(n));
  const body = opts.generator ? `"use strict";\n${js}\nreturn ${GEN_NAME};` : `"use strict";\n${js}`;
  let fn: (...a: unknown[]) => unknown;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(...names, body) as (...a: unknown[]) => unknown;
  } catch (e) {
    throw new DslError(`syntax error: ${(e as Error).message}`);
  }
  return {
    source: js,
    run: (scope) => fn(...names.map((n) => scope[n])),
  };
}

export { UNARY_OPS };
