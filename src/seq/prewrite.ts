// sclang's Prewrite, the L-system pattern, ported from
// SCClassLibrary/Common/Streams/Prewrite.sc so that it behaves the same way.
// Each value from `pattern` is rewritten `levels` deep through `dict`,
// depth-first and lazily, and the leaves come out one at a time.
//
// The sclang semantics this keeps:
// - A plain value, an array or a string as the pattern repeats forever
//   (Object.asStream and Object.next return the object itself); a stream or
//   a pattern (another Prewrite) ends when it ends.
// - A rule's value is a list: an array, or a string read as its characters
//   (a String is a SequenceableCollection). A value with no rule passes
//   through unchanged, like a turtle's + and -.
// - Leaves are yielded whole (Object.embedInStream yields the object), so a
//   nested array is one value, a chord; patterns and streams are embedded.

/** Rules: a value → its children. An object (keys compare as strings) or a Map (keys compare by identity). */
export type PrewriteRules = Record<string | number, unknown> | Map<unknown, unknown>;

interface StreamLike {
  next(): unknown;
}

export interface PrewriteStream extends StreamLike {
  /** The next value, or undefined (sclang's nil) when a finite pattern has run out. */
  next(): unknown;
  /** The next n values, as sclang's Stream.nextN. */
  nextN(n: number): unknown[];
  /** Every value until the stream ends, as sclang's Stream.all (refuses an endless one). */
  all(limit?: number): unknown[];
  /** Start again from the beginning. */
  reset(): void;
}

export interface PrewritePattern extends PrewriteStream {
  readonly pattern: unknown;
  readonly dict: PrewriteRules;
  readonly levels: number;
  /** A fresh, independent stream (the pattern itself is also one). */
  asStream(): PrewriteStream;
}

/** If the source repeats this many times without producing anything, the rules produce nothing: stop rather than hang. */
const MAX_EMPTY = 10_000;

const isPattern = (x: unknown): x is { asStream(): StreamLike } =>
  typeof x === 'object' && x !== null && typeof (x as { asStream?: unknown }).asStream === 'function';
const isStream = (x: unknown): x is StreamLike =>
  typeof x === 'object' && x !== null && typeof (x as { next?: unknown }).next === 'function';
const ended = (v: unknown) => v === undefined || v === null;

function childrenOf(dict: PrewriteRules, item: unknown): unknown {
  if (dict instanceof Map) return dict.get(item);
  if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') return undefined;
  const key = String(item);
  return Object.prototype.hasOwnProperty.call(dict, key) ? (dict as Record<string, unknown>)[key] : undefined;
}

/** isSequenceableCollection: arrays and strings are lists; anything else is one item. */
const itemsOf = (list: unknown): unknown[] => (Array.isArray(list) ? list : typeof list === 'string' ? [...list] : [list]);

/** embedInStream: patterns and streams are embedded; anything else is yielded as it is. */
function* embed(item: unknown): Generator<unknown> {
  const s = isPattern(item) ? item.asStream() : isStream(item) ? item : null;
  if (!s) {
    yield item;
    return;
  }
  for (let v = s.next(); !ended(v); v = s.next()) yield v;
}

/** rewriteList */
function* rewrite(list: unknown, dict: PrewriteRules, level: number): Generator<unknown> {
  for (const item of itemsOf(list)) {
    const children = level > 0 ? childrenOf(dict, item) : undefined;
    if (!ended(children)) yield* rewrite(children, dict, level - 1);
    else yield* embed(item);
  }
}

function* run(pattern: unknown, dict: PrewriteRules, levels: number): Generator<unknown> {
  const source = isPattern(pattern) ? pattern.asStream() : isStream(pattern) ? pattern : { next: () => pattern };
  let empty = 0;
  for (let v = source.next(); !ended(v); v = source.next()) {
    let produced = false;
    for (const out of rewrite(v, dict, levels)) {
      produced = true;
      yield out;
    }
    if (produced) empty = 0;
    else if (++empty >= MAX_EMPTY) throw new Error('Prewrite: the rules rewrite the pattern into nothing');
  }
}

function streamOf(start: () => Generator<unknown>): PrewriteStream {
  let it = start();
  const next = () => it.next().value;
  return {
    next,
    nextN: (n: number) => Array.from({ length: Math.max(0, Math.floor(n)) }, next),
    all: (limit = 100_000) => {
      const out: unknown[] = [];
      for (let v = next(); !ended(v); v = next()) {
        if (out.length >= limit) throw new Error(`Prewrite: .all() stopped after ${limit} values; this pattern repeats forever, so take .nextN(n)`);
        out.push(v);
      }
      return out;
    },
    reset: () => {
      it = start();
    },
  };
}

/**
 * Prewrite(pattern, dict, levels = 1): sclang's L-system pattern.
 * Prewrite(0, { 0: [0, 1], 1: [1, 0] }, 4).nextN(16) is the Thue–Morse word;
 * Prewrite('A', { A: 'AB', B: 'A' }, 5).nextN(13).join('') is 'ABAABABAABAAB'.
 */
export function Prewrite(pattern: unknown, dict: PrewriteRules, levels = 1): PrewritePattern {
  if (dict === null || typeof dict !== 'object') {
    throw new Error('Prewrite(pattern, dict, levels): dict maps each value to its children, e.g. { 0: [0, 1], 1: [1, 0] }');
  }
  const start = () => run(pattern, dict, levels);
  const own = streamOf(start);
  return { pattern, dict, levels, ...own, asStream: () => streamOf(start) };
}
