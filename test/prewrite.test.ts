import { describe, expect, it } from 'vitest';
import { Prewrite } from '../src/seq/prewrite';
import { patternHelpers } from '../src/seq/helpers';
import { baseScope } from '../src/sc/scope';
import { compileModule } from '../src/runtime/module-def';

const compileControl = (code: string) =>
  compileModule({ name: 't', kind: 'control', code, resolve: () => { throw new Error('no inputs'); }, resolveSample: () => { throw new Error('no samples'); } });

/** A finite stream, as sclang's Pseq(list, 1).asStream. */
const once = (xs: unknown[]) => {
  let i = 0;
  return { next: () => xs[i++] };
};

describe('Prewrite', () => {
  it('matches the sclang help example', () => {
    // a = Prewrite(0, (0: #[2, 0], 1: #[0, 0, 1], 2: #[1, 0, 1]), 4); x = a.asStream; 30.do({ x.next.postln })
    const x = Prewrite(0, { 0: [2, 0], 1: [0, 0, 1], 2: [1, 0, 1] }, 4).asStream();
    expect(x.nextN(30)).toEqual([2, 0, 2, 0, 0, 0, 1, 1, 0, 1, 2, 0, 2, 0, 2, 0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 0, 1, 1, 0, 1]);
  });

  it('grows the classic words', () => {
    expect(Prewrite(0, { 0: [0, 1], 1: [1, 0] }, 4).nextN(16).join('')).toBe('0110100110010110');
    expect(Prewrite('A', { A: 'AB', B: 'A' }, 5).nextN(13).join('')).toBe('ABAABABAABAAB');
  });

  it('rewrites levels deep, one level by default, none at 0', () => {
    const rules = { 0: [0, 1], 1: [1, 0] };
    expect(Prewrite(0, rules).nextN(2)).toEqual([0, 1]);
    expect(Prewrite(0, rules, 2).nextN(4)).toEqual([0, 1, 1, 0]);
    expect(Prewrite(0, rules, 0).nextN(3)).toEqual([0, 0, 0]);
  });

  it('repeats a plain value forever, as Object.asStream does', () => {
    expect(Prewrite(0, { 0: [0, 1], 1: [1, 0] }, 1).nextN(6)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(Prewrite([1, 0], { 0: [0, 1], 1: [1, 0] }, 1).nextN(8)).toEqual([1, 0, 0, 1, 1, 0, 0, 1]);
  });

  it('passes values without a rule through, like a turtle', () => {
    expect(Prewrite('F', { F: 'F+F-F' }, 2).nextN(17).join('')).toBe('F+F-F+F+F-F-F+F-F');
  });

  it('yields a nested array as one value, and a string element whole', () => {
    expect(Prewrite(0, { 0: [[0, 4, 7], 1] }, 1).nextN(2)).toEqual([[0, 4, 7], 1]);
    expect(Prewrite('k', { k: ['kick', 'hat'] }, 1).nextN(2)).toEqual(['kick', 'hat']);
  });

  it('ends with a finite source', () => {
    const p = Prewrite(once([0, 1]), { 0: [0, 1], 1: [1, 0] }, 1);
    expect(p.all()).toEqual([0, 1, 1, 0]);
    expect(p.next()).toBeUndefined();
  });

  it('embeds patterns and streams found in the rules', () => {
    const inner = { asStream: () => once([7, 8]) };
    expect(Prewrite(0, { 0: [1, inner] }, 1).nextN(3)).toEqual([1, 7, 8]);
  });

  it('takes a Map for keys that compare by identity', () => {
    const a = { name: 'a' };
    const b = { name: 'b' };
    const rules = new Map<unknown, unknown>([[a, [a, b]], [b, [a]]]);
    expect(Prewrite(a, rules, 3).nextN(5).map((x) => (x as { name: string }).name).join('')).toBe('abaab');
  });

  it('gives independent streams and resets', () => {
    const p = Prewrite(0, { 0: [0, 1], 1: [1, 0] }, 2);
    const s = p.asStream();
    s.nextN(3);
    expect(p.asStream().nextN(4)).toEqual([0, 1, 1, 0]);
    expect(s.next()).toBe(0);
    s.reset();
    expect(s.nextN(4)).toEqual([0, 1, 1, 0]);
  });

  it('refuses to hang', () => {
    expect(() => Prewrite(0, { 0: [] }, 1).next()).toThrow(/into nothing/);
    expect(() => Prewrite(0, { 0: [0, 1] }, 1).all(100)).toThrow(/nextN/);
    expect(() => Prewrite(0, null as never)).toThrow(/dict/);
  });

  it('is in routine and module code', () => {
    expect(patternHelpers().Prewrite).toBe(Prewrite);
    expect(baseScope().Prewrite).toBe(Prewrite);
  });

  it('grows a word at build time in module code, locked to the transport', () => {
    const m = compileControl(`
      const word = Prewrite(0, { 0: [0, 1], 1: [1, 0] }, 8).nextN(256);
      const step = (BeatPhase.kr(64) * 4).floor();
      ({ trig: Changed.kr(step), sym: Select.kr(step, word) })`);
    const select = m.data.ugens.find((u) => u.name === 'Select');
    expect(select?.inputs).toHaveLength(257);
  });

  it('feeds Dseq from a string grammar in module code', () => {
    const m = compileControl(`
      const fib = Prewrite('A', { A: 'AB', B: 'A' }, 6).nextN(21).map((c) => (c === 'A' ? 1 : 0));
      Demand.kr(Impulse.kr(4), 0, Dseq(fib, inf))`);
    const dseq = m.data.ugens.find((u) => u.name === 'Dseq');
    expect(dseq?.inputs).toHaveLength(22);
  });
});
