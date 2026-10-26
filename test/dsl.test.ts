import { describe, expect, it } from 'vitest';
import { $bin, $call, transform } from '../src/sc/dsl';
import { map, unmap, toSpec } from '../src/runtime/specs';
import { euclid, degree, quantize } from '../src/seq/helpers';

const T = (src: string) => transform(src, { operators: true, loopGuard: true, autoReturn: true });

describe('transform', () => {
  it('rewrites arithmetic and comparisons, not identity or logic', () => {
    const js = T('a * b + c < d && e === f');
    expect(js).toContain(`$bin("<", $bin("+", $bin("*", a, b), c), d)`);
    expect(js).toContain('&&');
    expect(js).toContain('===');
  });
  it('keeps negative literals and rewrites negation of expressions', () => {
    expect(T('x = -1')).toContain('-1');
    expect(T('y = -x')).toContain(`$un("neg", x)`);
  });
  it('rewrites compound assignment', () => {
    expect(T('let s = 0; s += a * 2')).toContain(`s = $bin("+", s, $bin("*", a, 2))`);
  });
  it('routes method calls through $call', () => {
    expect(T('sig.tanh()')).toContain(`$call(sig, "tanh", [])`);
    expect(T('SinOsc.ar(440, 0, 0.1)')).toContain(`$call(SinOsc, "ar", [440, 0, 0.1])`);
  });
  it('guards loops and returns the last expression', () => {
    const js = T('for (let i = 0; i < 3; i++) { x(i) }\nfoo');
    expect(js).toContain('$guard()');
    expect(js.trim().endsWith('return foo;')).toBe(true);
  });
  it('reports syntax errors with a line', () => {
    expect(() => T('const a = ;')).toThrow(/syntax error at line 1/);
  });
  it('wraps generator bodies for routines', () => {
    const js = transform('while (true) { yield 1 }', { operators: false, loopGuard: true, autoReturn: false, generator: true });
    expect(js).toContain('function* __routine__');
    expect(js).toContain('yield 1');
  });
});

describe('runtime helpers', () => {
  it('$bin keeps plain JS semantics for numbers and strings', () => {
    expect($bin('+', 2, 3)).toBe(5);
    expect($bin('<', 2, 3)).toBe(true);
    expect($bin('+', 'freq', 1)).toBe('freq1');
  });
  it('$bin does sclang array maths', () => {
    expect($bin('*', [1, 2, 3], 2)).toEqual([2, 4, 6]);
    expect($bin('+', [1, 2, 3], [10, 20])).toEqual([11, 22, 13]);
  });
  it('$call falls back to signal methods on numbers and arrays', () => {
    expect($call(69, 'midicps', [])).toBeCloseTo(440);
    expect($call([60, 72], 'midicps', [])).toEqual([expect.closeTo(261.6256, 3), expect.closeTo(523.2511, 3)]);
    expect($call([1, 2, 3], 'sum', [])).toBe(6);
    expect($call('abc', 'toUpperCase', [])).toBe('ABC');
  });
});

describe('specs', () => {
  it('map/unmap round-trip on every warp', () => {
    for (const spec of [toSpec('freq', 440), toSpec([0, 1], 0.5), toSpec('amp', 0.5), toSpec([0.01, 10, 'exp'], 1), toSpec([0, 1, -4], 0.5), toSpec('db', -6)]) {
      for (const p of [0, 0.1, 0.5, 0.9, 1]) {
        const v = map(spec, p);
        if (Number.isFinite(v)) expect(unmap(spec, v)).toBeCloseTo(p, 5);
      }
    }
  });
  it('freq is exponential', () => {
    expect(map(toSpec('freq', 440), 0.5)).toBeCloseTo(Math.sqrt(20 * 20000), 3);
  });
});

describe('music helpers', () => {
  it('euclid gives the tresillo', () => {
    expect(euclid(3, 8)).toEqual([1, 0, 0, 1, 0, 0, 1, 0]);
    expect(euclid(5, 8).reduce((a, b) => a + b, 0)).toBe(5);
  });
  it('degrees and quantize', () => {
    expect(degree(0, 'major', 60)).toBe(60);
    expect(degree(7, 'major', 60)).toBe(72);
    expect(degree(-1, 'minor', 60)).toBe(58);
    expect(quantize(61, 'major', 60)).toBe(60);
  });
});
