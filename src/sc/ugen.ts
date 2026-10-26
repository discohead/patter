// The UGen graph: what DSL code builds, and what synthdef.ts serialises.
//
// Mirrors sclang's model: a UGen has a rate, inputs (constants or outputs of
// earlier UGens), outputs, and a special index. User code handles `Sig`
// values (sclang's OutputProxy) and arrays of them (multichannel signals).

import { BINARY_OPS, UNARY_OPS, foldBinary, foldUnary, type BinaryOp, type UnaryOp } from './ops';

export type Rate = 'scalar' | 'control' | 'audio' | 'demand';
export const RATE_CODE: Record<Rate, number> = { scalar: 0, control: 1, audio: 2, demand: 3 };
const RATE_RANK: Record<Rate, number> = { scalar: 0, control: 1, audio: 2, demand: 3 };

/** A UGen input: a constant or one output of a UGen. */
export type Input = number | Sig;
/** Anything DSL code may pass where a signal is expected (possibly multichannel). */
export type SigLike = number | Sig | SigLike[];

export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphError';
  }
}

// ── Build context ───────────────────────────────────────────────────────────

export interface ControlDecl {
  name: string;
  rate: 'scalar' | 'trigger' | 'audio' | 'control';
  defaults: number[];
  /** The proxies handed to user code, one per value; rewired at finish. */
  sigs: Sig[];
}

export class GraphBuilder {
  readonly ugens: UGen[] = [];
  readonly controls: ControlDecl[] = [];
  readonly warnings: string[] = [];
  /** sclang's widthFirstUGens: FFT-chain UGens every later UGen must follow. */
  readonly widthFirst: UGen[] = [];
  private seq = 0;

  nextIndex(): number {
    return this.seq++;
  }

  add(u: UGen): void {
    this.ugens.push(u);
  }

  warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  /** Declare a named control and return its signal(s). */
  control(name: string, rate: ControlDecl['rate'], defaults: number[]): Sig[] {
    if (this.controls.some((c) => c.name === name)) {
      throw new GraphError(`control '${name}' is declared twice`);
    }
    // A placeholder UGen per control; synthdef.ts merges them per rate.
    const ugenRate: Rate = rate === 'scalar' ? 'scalar' : rate === 'audio' ? 'audio' : 'control';
    const placeholder = new UGen(this, '__control__', ugenRate, [], defaults.length, 0, { pure: true });
    const decl: ControlDecl = { name, rate, defaults, sigs: placeholder.outputs };
    this.controls.push(decl);
    return placeholder.outputs;
  }
}

let current: GraphBuilder | null = null;

export function builder(): GraphBuilder {
  if (!current) throw new GraphError('UGens can only be created while a SynthDef is being built');
  return current;
}

export function withBuilder<T>(b: GraphBuilder, fn: () => T): T {
  const prev = current;
  current = b;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

// ── UGen and Sig ────────────────────────────────────────────────────────────

export interface UGenFlags {
  pure?: boolean;
  sideEffect?: boolean;
  /** sclang WidthFirstUGen (FFT chains); defaults to a name-based guess. */
  widthFirst?: boolean;
}

export class UGen {
  readonly outputs: Sig[];
  /** Creation order; sclang's synthIndex. Controls are moved to the front at finish. */
  synthIndex: number;
  pure: boolean;
  sideEffect: boolean;

  constructor(
    readonly graph: GraphBuilder,
    public name: string,
    public rate: Rate,
    public inputs: Input[],
    numOutputs: number,
    public specialIndex: number,
    flags: UGenFlags = {},
  ) {
    for (const i of inputs) {
      if (typeof i === 'number') {
        // inf is a legitimate constant (Dseq repeats); NaN is always a bug upstream.
        if (Number.isNaN(i)) throw new GraphError(`${name}: an input is NaN (check the arithmetic feeding it)`);
      } else if (!(i instanceof Sig)) {
        throw new GraphError(`${name}: input is not a signal or number (${describe(i)})`);
      }
    }
    this.synthIndex = graph.nextIndex();
    this.pure = flags.pure ?? false;
    this.sideEffect = flags.sideEffect ?? false;
    this.outputs = Array.from({ length: numOutputs }, (_, i) => new Sig(this, i));
    this.widthFirstAntecedents = [...graph.widthFirst];
    if (flags.widthFirst ?? isWidthFirst(name)) graph.widthFirst.push(this);
    graph.add(this);
  }

  readonly widthFirstAntecedents: UGen[];
}

/** FFT chains operate on buffers in place, so sclang orders them width-first. */
function isWidthFirst(name: string): boolean {
  return name.startsWith('PV_') || name === 'FFT' || name === 'IFFT' || name === 'LocalBuf' || name === 'FFTTrigger' || name === 'PackFFT';
}

export function describe(x: unknown): string {
  if (x === null) return 'null';
  if (x === undefined) return 'undefined';
  if (x instanceof Sig) return `${x.ugen.name}${x.ugen.outputs.length > 1 ? `[${x.index}]` : ''}`;
  if (Array.isArray(x)) return `[${x.map(describe).join(', ')}]`;
  if (typeof x === 'object') return (x as object).constructor?.name ?? 'object';
  return String(x);
}

/** One output of a UGen (sclang's OutputProxy), with sclang-style math methods. */
export class Sig {
  constructor(
    public ugen: UGen,
    public index: number,
  ) {}

  get rate(): Rate {
    return this.ugen.rate;
  }

  // arithmetic
  add(b: SigLike) { return bin('+', this, b); }
  sub(b: SigLike) { return bin('-', this, b); }
  mul(b: SigLike) { return bin('*', this, b); }
  div(b: SigLike) { return bin('/', this, b); }
  mod(b: SigLike) { return bin('%', this, b); }
  pow(b: SigLike) { return bin('pow', this, b); }
  min(b: SigLike) { return bin('min', this, b); }
  max(b: SigLike) { return bin('max', this, b); }
  round(b: SigLike = 1) { return bin('round', this, b); }
  trunc(b: SigLike = 1) { return bin('trunc', this, b); }
  atan2(b: SigLike) { return bin('atan2', this, b); }
  hypot(b: SigLike) { return bin('hypot', this, b); }
  ring1(b: SigLike) { return bin('ring1', this, b); }
  ring2(b: SigLike) { return bin('ring2', this, b); }
  ring3(b: SigLike) { return bin('ring3', this, b); }
  ring4(b: SigLike) { return bin('ring4', this, b); }
  sumsqr(b: SigLike) { return bin('sumsqr', this, b); }
  difsqr(b: SigLike) { return bin('difsqr', this, b); }
  absdif(b: SigLike) { return bin('absdif', this, b); }
  thresh(b: SigLike) { return bin('thresh', this, b); }
  amclip(b: SigLike) { return bin('amclip', this, b); }
  scaleneg(b: SigLike) { return bin('scaleneg', this, b); }
  clip2(b: SigLike = 1) { return bin('clip2', this, b); }
  fold2(b: SigLike = 1) { return bin('fold2', this, b); }
  wrap2(b: SigLike = 1) { return bin('wrap2', this, b); }
  excess(b: SigLike = 1) { return bin('excess', this, b); }
  lt(b: SigLike) { return bin('<', this, b); }
  gt(b: SigLike) { return bin('>', this, b); }
  le(b: SigLike) { return bin('<=', this, b); }
  ge(b: SigLike) { return bin('>=', this, b); }
  eq(b: SigLike) { return bin('==', this, b); }
  ne(b: SigLike) { return bin('!=', this, b); }

  // unary
  neg() { return un('neg', this); }
  abs() { return un('abs', this); }
  sign() { return un('sign', this); }
  squared() { return un('squared', this); }
  cubed() { return un('cubed', this); }
  sqrt() { return un('sqrt', this); }
  exp() { return un('exp', this); }
  log() { return un('log', this); }
  log2() { return un('log2', this); }
  log10() { return un('log10', this); }
  reciprocal() { return un('reciprocal', this); }
  midicps() { return un('midicps', this); }
  cpsmidi() { return un('cpsmidi', this); }
  midiratio() { return un('midiratio', this); }
  ratiomidi() { return un('ratiomidi', this); }
  dbamp() { return un('dbamp', this); }
  ampdb() { return un('ampdb', this); }
  octcps() { return un('octcps', this); }
  cpsoct() { return un('cpsoct', this); }
  floor() { return un('floor', this); }
  ceil() { return un('ceil', this); }
  frac() { return un('frac', this); }
  sin() { return un('sin', this); }
  cos() { return un('cos', this); }
  tan() { return un('tan', this); }
  tanh() { return un('tanh', this); }
  asin() { return un('asin', this); }
  acos() { return un('acos', this); }
  atan() { return un('atan', this); }
  distort() { return un('distort', this); }
  softclip() { return un('softclip', this); }
  not() { return un('not', this); }
  ramp() { return un('ramp', this); }
  scurve() { return un('scurve', this); }

  // ranges & mappings (sclang UGen methods); implemented in methods.ts
  range(lo: SigLike = 0, hi: SigLike = 1): SigLike { return methods.range(this, lo, hi); }
  exprange(lo: SigLike = 0.01, hi: SigLike = 1): SigLike { return methods.exprange(this, lo, hi); }
  unipolar(m: SigLike = 1): SigLike { return methods.unipolar(this, m); }
  bipolar(m: SigLike = 1): SigLike { return methods.bipolar(this, m); }
  linlin(a: SigLike, b: SigLike, c: SigLike, d: SigLike, clip: ClipMode = 'minmax'): SigLike { return methods.linlin(this, a, b, c, d, clip); }
  linexp(a: SigLike, b: SigLike, c: SigLike, d: SigLike, clip: ClipMode = 'minmax'): SigLike { return methods.linexp(this, a, b, c, d, clip); }
  explin(a: SigLike, b: SigLike, c: SigLike, d: SigLike, clip: ClipMode = 'minmax'): SigLike { return methods.explin(this, a, b, c, d, clip); }
  expexp(a: SigLike, b: SigLike, c: SigLike, d: SigLike, clip: ClipMode = 'minmax'): SigLike { return methods.expexp(this, a, b, c, d, clip); }
  lincurve(a: SigLike, b: SigLike, c: SigLike, d: SigLike, curve: SigLike = -4, clip: ClipMode = 'minmax'): SigLike { return methods.lincurve(this, a, b, c, d, curve, clip); }
  clip(lo: SigLike = -1, hi: SigLike = 1): SigLike { return methods.clip(this, lo, hi); }
  fold(lo: SigLike = -1, hi: SigLike = 1): SigLike { return methods.fold(this, lo, hi); }
  wrap(lo: SigLike = -1, hi: SigLike = 1): SigLike { return methods.wrap(this, lo, hi); }
  madd(mul: SigLike = 1, add: SigLike = 0): SigLike { return madd(this, mul, add); }
  lag(t: SigLike = 0.1): SigLike { return methods.lag(this, t); }
  lag2(t: SigLike = 0.1): SigLike { return methods.lag2(this, t); }
  lag3(t: SigLike = 0.1): SigLike { return methods.lag3(this, t); }
  lagud(up: SigLike = 0.1, down: SigLike = 0.1): SigLike { return methods.lagud(this, up, down); }
  lag3ud(up: SigLike = 0.1, down: SigLike = 0.1): SigLike { return methods.lag3ud(this, up, down); }
  slew(up: SigLike = 1, down: SigLike = 1): SigLike { return methods.slew(this, up, down); }
  dup(n = 2): SigLike[] { return Array.from({ length: n }, () => this); }
  poll(trig: SigLike = 10, label = 'poll'): Sig { methods.poll(this, trig, label); return this; }
}

export type ClipMode = 'minmax' | 'min' | 'max' | 'none' | null;

/** UGen methods that need other UGens; filled in by methods.ts to avoid import cycles. */
export const methods: {
  range: (s: SigLike, lo: SigLike, hi: SigLike) => SigLike;
  exprange: (s: SigLike, lo: SigLike, hi: SigLike) => SigLike;
  unipolar: (s: SigLike, m: SigLike) => SigLike;
  bipolar: (s: SigLike, m: SigLike) => SigLike;
  linlin: (s: SigLike, a: SigLike, b: SigLike, c: SigLike, d: SigLike, clip: ClipMode) => SigLike;
  linexp: (s: SigLike, a: SigLike, b: SigLike, c: SigLike, d: SigLike, clip: ClipMode) => SigLike;
  explin: (s: SigLike, a: SigLike, b: SigLike, c: SigLike, d: SigLike, clip: ClipMode) => SigLike;
  expexp: (s: SigLike, a: SigLike, b: SigLike, c: SigLike, d: SigLike, clip: ClipMode) => SigLike;
  lincurve: (s: SigLike, a: SigLike, b: SigLike, c: SigLike, d: SigLike, curve: SigLike, clip: ClipMode) => SigLike;
  clip: (s: SigLike, lo: SigLike, hi: SigLike) => SigLike;
  fold: (s: SigLike, lo: SigLike, hi: SigLike) => SigLike;
  wrap: (s: SigLike, lo: SigLike, hi: SigLike) => SigLike;
  lag: (s: SigLike, t: SigLike) => SigLike;
  lag2: (s: SigLike, t: SigLike) => SigLike;
  lag3: (s: SigLike, t: SigLike) => SigLike;
  lagud: (s: SigLike, u: SigLike, d: SigLike) => SigLike;
  lag3ud: (s: SigLike, u: SigLike, d: SigLike) => SigLike;
  slew: (s: SigLike, u: SigLike, d: SigLike) => SigLike;
  poll: (s: SigLike, trig: SigLike, label: string) => void;
} = {} as never;

// ── Rates ───────────────────────────────────────────────────────────────────

export function rateOf(x: SigLike): Rate {
  if (typeof x === 'number') return 'scalar';
  if (x instanceof Sig) return x.rate;
  if (Array.isArray(x)) {
    let r: Rate = 'scalar';
    for (const e of x) r = maxRate(r, rateOf(e));
    return r;
  }
  return 'scalar';
}

export function maxRate(a: Rate, b: Rate): Rate {
  return RATE_RANK[a] >= RATE_RANK[b] ? a : b;
}

// ── Multichannel expansion ──────────────────────────────────────────────────

export function isSigLike(x: unknown): x is SigLike {
  return typeof x === 'number' || x instanceof Sig || (Array.isArray(x) && x.every(isSigLike));
}

/**
 * sclang's multiNew: if any argument is an array, build one result per
 * channel (wrapping shorter arrays) and return the array of results.
 */
export function expand<T>(args: unknown[], build: (flat: unknown[]) => T): T | unknown[] {
  let size = 0;
  for (const a of args) if (Array.isArray(a)) size = Math.max(size, a.length);
  if (size === 0) {
    if (args.some((a) => Array.isArray(a))) return []; // an empty array input
    return build(args);
  }
  const out: unknown[] = [];
  for (let i = 0; i < size; i++) {
    const slice = args.map((a) => (Array.isArray(a) ? a[i % a.length] : a));
    out.push(expand(slice, build));
  }
  return out;
}

// ── Operators ───────────────────────────────────────────────────────────────

function asInput(x: unknown, where: string): Input {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (x instanceof Sig) return x;
  throw new GraphError(`${where}: expected a signal or number, got ${describe(x)}`);
}

const isNum = (x: unknown): x is number => typeof x === 'number';

/** BinaryOpUGen with sclang's degenerate-case elimination and constant folding. */
export function bin(op: BinaryOp, a: SigLike, b: SigLike): SigLike {
  if (Array.isArray(a) || Array.isArray(b)) {
    return expand([a, b], ([x, y]) => bin(op, x as SigLike, y as SigLike)) as SigLike;
  }
  if (isNum(a) && isNum(b)) return foldBinary(op, a, b);
  const A = asInput(a, `operator ${op}`);
  const B = asInput(b, `operator ${op}`);
  switch (op) {
    case '*':
      if (A === 0 || B === 0) return 0;
      if (A === 1) return B;
      if (B === 1) return A;
      if (A === -1) return un('neg', B);
      if (B === -1) return un('neg', A);
      break;
    case '+':
      if (A === 0) return B;
      if (B === 0) return A;
      break;
    case '-':
      if (A === 0) return un('neg', B);
      if (B === 0) return A;
      break;
    case '/':
      if (B === 1) return A;
      if (B === -1) return un('neg', A);
      break;
  }
  const rate = maxRate(rateOf(A), rateOf(B));
  return new UGen(builder(), 'BinaryOpUGen', rate, [A, B], 1, BINARY_OPS[op], { pure: true }).outputs[0];
}

export function un(op: UnaryOp, a: SigLike): SigLike {
  if (Array.isArray(a)) return a.map((x) => un(op, x));
  if (isNum(a)) return foldUnary(op, a);
  const A = asInput(a, `operator ${op}`);
  return new UGen(builder(), 'UnaryOpUGen', rateOf(A), [A], 1, UNARY_OPS[op], { pure: true }).outputs[0];
}

function canBeMulAdd(i: Input, m: Input, a: Input): boolean {
  const ri = rateOf(i);
  if (ri === 'audio') return true;
  if (ri === 'control') {
    const rm = rateOf(m);
    const ra = rateOf(a);
    return (rm === 'control' || rm === 'scalar') && (ra === 'control' || ra === 'scalar');
  }
  return false;
}

/** sclang's MulAdd.new1, degenerate cases included. */
export function madd(input: SigLike, mul: SigLike = 1, add: SigLike = 0): SigLike {
  if (Array.isArray(input) || Array.isArray(mul) || Array.isArray(add)) {
    return expand([input, mul, add], ([i, m, a]) => madd(i as SigLike, m as SigLike, a as SigLike)) as SigLike;
  }
  if (mul === 0) return add;
  const minus = mul === -1;
  const nomul = mul === 1;
  const noadd = add === 0;
  if (nomul && noadd) return input;
  if (minus && noadd) return un('neg', input);
  if (noadd) return bin('*', input, mul);
  if (minus) return bin('-', add, input);
  if (nomul) return bin('+', input, add);
  if (isNum(input) && isNum(mul) && isNum(add)) return input * mul + add;
  const I = asInput(input, 'MulAdd');
  const M = asInput(mul, 'MulAdd');
  const A = asInput(add, 'MulAdd');
  const rate = maxRate(maxRate(rateOf(I), rateOf(M)), rateOf(A));
  if (canBeMulAdd(I, M, A)) return new UGen(builder(), 'MulAdd', rate, [I, M, A], 1, 0, { pure: true }).outputs[0];
  if (canBeMulAdd(M, I, A)) return new UGen(builder(), 'MulAdd', rate, [M, I, A], 1, 0, { pure: true }).outputs[0];
  return bin('+', bin('*', I, M), A);
}
