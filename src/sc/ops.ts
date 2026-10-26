// Operator special indices, exactly as scsynth's BinaryOpUGens.cpp /
// UnaryOpUGens.cpp enums number them (opIdentical/opNotIdentical are
// commented out there, so min is 12).

export const BINARY_OPS = {
  '+': 0, '-': 1, '*': 2, div: 3, '/': 4, '%': 5,
  '==': 6, '!=': 7, '<': 8, '>': 9, '<=': 10, '>=': 11,
  min: 12, max: 13, bitAnd: 14, bitOr: 15, bitXor: 16, lcm: 17, gcd: 18,
  round: 19, roundUp: 20, trunc: 21, atan2: 22, hypot: 23, hypotApx: 24,
  pow: 25, leftShift: 26, rightShift: 27, unsignedRightShift: 28, fill: 29,
  ring1: 30, ring2: 31, ring3: 32, ring4: 33, difsqr: 34, sumsqr: 35,
  sqrsum: 36, sqrdif: 37, absdif: 38, thresh: 39, amclip: 40, scaleneg: 41,
  clip2: 42, excess: 43, fold2: 44, wrap2: 45, firstArg: 46, rrand: 47,
  exprand: 48,
} as const;

export const UNARY_OPS = {
  neg: 0, not: 1, isNil: 2, notNil: 3, bitNot: 4, abs: 5, asFloat: 6,
  asInteger: 7, ceil: 8, floor: 9, frac: 10, sign: 11, squared: 12, cubed: 13,
  sqrt: 14, exp: 15, reciprocal: 16, midicps: 17, cpsmidi: 18, midiratio: 19,
  ratiomidi: 20, dbamp: 21, ampdb: 22, octcps: 23, cpsoct: 24, log: 25,
  log2: 26, log10: 27, sin: 28, cos: 29, tan: 30, asin: 31, acos: 32,
  atan: 33, sinh: 34, cosh: 35, tanh: 36, rand: 37, rand2: 38, linrand: 39,
  bilinrand: 40, sum3rand: 41, distort: 42, softclip: 43, coin: 44,
  digitValue: 45, silence: 46, thru: 47, rectWindow: 48, hanWindow: 49,
  welchWindow: 50, triWindow: 51, ramp: 52, scurve: 53,
} as const;

export type BinaryOp = keyof typeof BINARY_OPS;
export type UnaryOp = keyof typeof UNARY_OPS;

const midicps = (n: number) => 440 * 2 ** ((n - 69) / 12);

/** Language-side evaluation of binary operators on plain numbers (sclang semantics). */
export function foldBinary(op: BinaryOp, a: number, b: number): number {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case 'div': return Math.trunc(a / b);
    case '%': return ((a % b) + b) % b; // sclang mod is always positive for positive b
    case '==': return a === b ? 1 : 0;
    case '!=': return a !== b ? 1 : 0;
    case '<': return a < b ? 1 : 0;
    case '>': return a > b ? 1 : 0;
    case '<=': return a <= b ? 1 : 0;
    case '>=': return a >= b ? 1 : 0;
    case 'min': return Math.min(a, b);
    case 'max': return Math.max(a, b);
    case 'round': return b === 0 ? a : Math.round(a / b) * b;
    case 'roundUp': return b === 0 ? a : Math.ceil(a / b) * b;
    case 'trunc': return b === 0 ? a : Math.trunc(a / b) * b;
    case 'atan2': return Math.atan2(a, b);
    case 'hypot': case 'hypotApx': return Math.hypot(a, b);
    case 'pow': return a ** b;
    case 'ring1': return a * b + a;
    case 'ring2': return a * b + a + b;
    case 'ring3': return a * a * b;
    case 'ring4': return a * a * b - a * b * b;
    case 'difsqr': return a * a - b * b;
    case 'sumsqr': return a * a + b * b;
    case 'sqrsum': return (a + b) ** 2;
    case 'sqrdif': return (a - b) ** 2;
    case 'absdif': return Math.abs(a - b);
    case 'thresh': return a < b ? 0 : a;
    case 'amclip': return b <= 0 ? 0 : a * b;
    case 'scaleneg': return a < 0 ? a * b : a;
    case 'clip2': return Math.max(-b, Math.min(b, a));
    case 'excess': return a - Math.max(-b, Math.min(b, a));
    case 'fold2': return fold(a, -b, b);
    case 'wrap2': return wrap(a, -b, b);
    case 'firstArg': return a;
    case 'rrand': return a + Math.random() * (b - a);
    case 'exprand': return a * Math.exp(Math.log(b / a) * Math.random());
    case 'bitAnd': return a & b;
    case 'bitOr': return a | b;
    case 'bitXor': return a ^ b;
    case 'leftShift': return a << b;
    case 'rightShift': return a >> b;
    case 'unsignedRightShift': return a >>> b;
    case 'lcm': return lcm(a, b);
    case 'gcd': return gcd(a, b);
    case 'fill': return 0;
  }
}

/** Language-side evaluation of unary operators on plain numbers. */
export function foldUnary(op: UnaryOp, a: number): number {
  switch (op) {
    case 'neg': return -a;
    case 'not': return a > 0 ? 0 : 1;
    case 'abs': return Math.abs(a);
    case 'ceil': return Math.ceil(a);
    case 'floor': return Math.floor(a);
    case 'frac': return a - Math.floor(a);
    case 'sign': return Math.sign(a);
    case 'squared': return a * a;
    case 'cubed': return a * a * a;
    case 'sqrt': return a < 0 ? -Math.sqrt(-a) : Math.sqrt(a);
    case 'exp': return Math.exp(a);
    case 'reciprocal': return 1 / a;
    case 'midicps': return midicps(a);
    case 'cpsmidi': return Math.log2(a / 440) * 12 + 69;
    case 'midiratio': return 2 ** (a / 12);
    case 'ratiomidi': return 12 * Math.log2(a);
    case 'dbamp': return 10 ** (a / 20);
    case 'ampdb': return 20 * Math.log10(a);
    case 'octcps': return 440 * 2 ** (a - 4.75);
    case 'cpsoct': return Math.log2(a / 440) + 4.75;
    case 'log': return Math.log(a);
    case 'log2': return Math.log2(a);
    case 'log10': return Math.log10(a);
    case 'sin': return Math.sin(a);
    case 'cos': return Math.cos(a);
    case 'tan': return Math.tan(a);
    case 'asin': return Math.asin(a);
    case 'acos': return Math.acos(a);
    case 'atan': return Math.atan(a);
    case 'sinh': return Math.sinh(a);
    case 'cosh': return Math.cosh(a);
    case 'tanh': return Math.tanh(a);
    case 'rand': return Math.random() * a;
    case 'rand2': return (Math.random() * 2 - 1) * a;
    case 'linrand': return Math.min(Math.random(), Math.random()) * a;
    case 'bilinrand': return (Math.random() - Math.random()) * a;
    case 'sum3rand': return (Math.random() + Math.random() + Math.random() - 1.5) * (2 / 3) * a;
    case 'distort': return a / (1 + Math.abs(a));
    case 'softclip': {
      const x = Math.abs(a);
      return x <= 0.5 ? a : (x - 0.25) / a;
    }
    case 'coin': return Math.random() < a ? 1 : 0;
    case 'silence': return 0;
    case 'thru': return a;
    case 'ramp': return Math.max(0, Math.min(1, a));
    case 'scurve': {
      const x = Math.max(0, Math.min(1, a));
      return x * x * (3 - 2 * x);
    }
    case 'asFloat': return a;
    case 'asInteger': return Math.trunc(a);
    case 'bitNot': return ~a;
    case 'isNil': return 0;
    case 'notNil': return 1;
    case 'digitValue': return a;
    case 'rectWindow': return a >= 0 && a <= 1 ? 1 : 0;
    case 'hanWindow': return a < 0 || a > 1 ? 0 : 0.5 - 0.5 * Math.cos(a * 2 * Math.PI);
    case 'welchWindow': return a < 0 || a > 1 ? 0 : Math.sin(a * Math.PI);
    case 'triWindow': return a < 0 || a > 1 ? 0 : a < 0.5 ? 2 * a : -2 * a + 2;
  }
}

function fold(x: number, lo: number, hi: number): number {
  if (lo === hi) return lo;
  const range = hi - lo;
  const range2 = range * 2;
  let c = (x - lo) % range2;
  if (c < 0) c += range2;
  return c > range ? range2 - c + lo : c + lo;
}

function wrap(x: number, lo: number, hi: number): number {
  if (lo === hi) return lo;
  const range = hi - lo;
  let c = (x - lo) % range;
  if (c < 0) c += range;
  return c + lo;
}

function gcd(a: number, b: number): number {
  a = Math.abs(Math.trunc(a));
  b = Math.abs(Math.trunc(b));
  while (b) [a, b] = [b, a % b];
  return a;
}

function lcm(a: number, b: number): number {
  const g = gcd(a, b);
  return g === 0 ? 0 : Math.abs(Math.trunc(a) * Math.trunc(b)) / g;
}

export { fold as foldNumber, wrap as wrapNumber };
