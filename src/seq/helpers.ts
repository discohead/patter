// Musical helpers available to routines: scales, chords, euclidean rhythms,
// random choices, and small pattern objects in the spirit of sclang's
// Pseq/Prand/Pwhite (each has .next()), and sclang's own Prewrite.

import { Prewrite } from './prewrite';

export const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  hirajoshi: [0, 2, 3, 7, 8],
  inSen: [0, 1, 5, 7, 10],
  pelog: [0, 1, 3, 7, 8],
  hungarianMinor: [0, 2, 3, 6, 7, 8, 11],
  diminished: [0, 2, 3, 5, 6, 8, 9, 11],
};

export const CHORDS: Record<string, number[]> = {
  major: [0, 4, 7], minor: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9], add9: [0, 4, 7, 14],
  m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
  power: [0, 7], quartal: [0, 5, 10],
};

function scaleOf(s: string | number[]): number[] {
  if (Array.isArray(s)) return s;
  const sc = SCALES[s];
  if (!sc) throw new Error(`unknown scale '${s}' (${Object.keys(SCALES).join(', ')})`);
  return sc;
}

/** Scale degree → MIDI note. Degrees wrap into octaves: degree(7, 'major', 60) = 72. */
export function degree(d: number, scale: string | number[] = 'major', root = 60): number {
  const sc = scaleOf(scale);
  const n = sc.length;
  const oct = Math.floor(d / n);
  const idx = ((Math.round(d) % n) + n) % n;
  return root + oct * 12 + sc[idx];
}

/** Snap a MIDI note to the nearest note of a scale. */
export function quantize(note: number, scale: string | number[] = 'major', root = 60): number {
  const sc = scaleOf(scale);
  let best = note;
  let dist = Infinity;
  const base = Math.floor((note - root) / 12) * 12 + root;
  for (const o of [-12, 0, 12]) {
    for (const s of sc) {
      const c = base + o + s;
      const dd = Math.abs(c - note);
      if (dd < dist) {
        dist = dd;
        best = c;
      }
    }
  }
  return best;
}

export function chord(root: number, type = 'major', inversion = 0): number[] {
  const c = CHORDS[type];
  if (!c) throw new Error(`unknown chord '${type}' (${Object.keys(CHORDS).join(', ')})`);
  const notes = c.map((i) => root + i);
  for (let i = 0; i < inversion; i++) notes.push(notes.shift()! + 12);
  return notes;
}

/** Bjorklund: k onsets spread over n steps, rotated. euclid(3, 8) = [1,0,0,1,0,0,1,0]. */
export function euclid(k: number, n: number, rotate = 0): number[] {
  if (n <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(((i + rotate) * k) / n) !== Math.floor(((i + rotate - 1) * k) / n) ? 1 : 0);
  // The formula above yields a rotation of the Bjorklund pattern starting on a hit at rotate=0.
  return out;
}

export const rrand = (lo: number, hi: number) =>
  Number.isInteger(lo) && Number.isInteger(hi) ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo + Math.random() * (hi - lo);
export const exprand = (lo: number, hi: number) => lo * Math.exp(Math.log(hi / lo) * Math.random());
export const coin = (p = 0.5) => Math.random() < p;
export const choose = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
export function wchoose<T>(a: T[], weights: number[]): T {
  const total = weights.reduce((x, y) => x + y, 0);
  let r = Math.random() * total;
  for (let i = 0; i < a.length; i++) {
    r -= weights[i] ?? 0;
    if (r <= 0) return a[i];
  }
  return a[a.length - 1];
}
export const shuffle = <T,>(a: T[]): T[] => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

export interface Stream<T> {
  next(): T;
}

/** Pseq: cycle through values. */
export function seq<T>(values: T[]): Stream<T> {
  let i = 0;
  return { next: () => values[i++ % values.length] };
}
/** Prand: random element each time. */
export function rand<T>(values: T[]): Stream<T> {
  return { next: () => choose(values) };
}
/** Pxrand: random, never the same twice in a row. */
export function xrand<T>(values: T[]): Stream<T> {
  let last = -1;
  return {
    next: () => {
      let i = Math.floor(Math.random() * values.length);
      if (values.length > 1 && i === last) i = (i + 1 + Math.floor(Math.random() * (values.length - 1))) % values.length;
      last = i;
      return values[i];
    },
  };
}
/** Pwhite */
export function white(lo: number, hi: number): Stream<number> {
  return { next: () => lo + Math.random() * (hi - lo) };
}
/** Pbrown: random walk within [lo, hi]. */
export function brown(lo: number, hi: number, step: number, start = (lo + hi) / 2): Stream<number> {
  let v = start;
  return {
    next: () => {
      v += (Math.random() * 2 - 1) * step;
      if (v > hi) v = 2 * hi - v;
      if (v < lo) v = 2 * lo - v;
      return Math.min(hi, Math.max(lo, v));
    },
  };
}
/** A Markov chain over states: transitions[state] = { next: weight, ... }. */
export function markov<T extends string | number>(transitions: Record<string, Record<string, number>>, start: T): Stream<T> {
  let state = String(start);
  return {
    next: () => {
      const current = state;
      const t = transitions[state];
      if (t) {
        const keys = Object.keys(t);
        state = wchoose(keys, keys.map((k) => t[k]));
      }
      return (typeof start === 'number' ? Number(current) : current) as T;
    },
  };
}
/** A shift register (Turing machine): each step rotates; with probability p a bit flips. */
export function turing(bits = 8, p = 0.1): Stream<number> & { value: () => number } {
  let reg = Math.floor(Math.random() * 2 ** bits);
  const mask = 2 ** bits - 1;
  return {
    next: () => {
      let top = (reg >> (bits - 1)) & 1;
      if (Math.random() < p) top ^= 1;
      reg = ((reg << 1) | top) & mask;
      return reg / mask;
    },
    value: () => reg / mask,
  };
}

export function patternHelpers(): Record<string, unknown> {
  return {
    SCALES, CHORDS, degree, quantize, chord, euclid,
    rrand, exprand, coin, choose, wchoose, shuffle,
    seq, rand, xrand, white, brown, markov, turing, Prewrite,
    midicps: (n: number) => 440 * 2 ** ((n - 69) / 12),
    cpsmidi: (f: number) => 69 + 12 * Math.log2(f / 440),
    dbamp: (db: number) => 10 ** (db / 20),
    ampdb: (a: number) => 20 * Math.log10(a),
    range: (n: number) => Array.from({ length: n }, (_, i) => i),
    inf: Infinity,
  };
}
