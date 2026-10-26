// SynthDef finalisation (controls, dead-code elimination, topological sort,
// constants) and the SCgf version 2 binary format, both directions.

import { GraphBuilder, GraphError, RATE_CODE, Sig, UGen, describe, type Input, type Rate } from './ugen';
import { localBuf } from './special';

export interface EncodedUGen {
  name: string;
  rate: number;
  /** [ugenIndex, outputIndex]; ugenIndex -1 means outputIndex is a constant index. */
  inputs: [number, number][];
  outputs: number[];
  specialIndex: number;
}

export interface SynthDefData {
  name: string;
  constants: number[];
  params: number[];
  paramNames: { name: string; index: number }[];
  ugens: EncodedUGen[];
  variants: { name: string; values: number[] }[];
}

export interface ControlInfo {
  name: string;
  rate: 'scalar' | 'trigger' | 'audio' | 'control';
  index: number;
  defaults: number[];
}

export interface BuiltSynthDef {
  data: SynthDefData;
  bytes: Uint8Array;
  controls: ControlInfo[];
  warnings: string[];
}

const CONTROL_ORDER: { rate: ControlInfo['rate']; ugen: string; ugenRate: Rate }[] = [
  { rate: 'scalar', ugen: 'Control', ugenRate: 'scalar' },
  { rate: 'trigger', ugen: 'TrigControl', ugenRate: 'control' },
  { rate: 'audio', ugen: 'AudioControl', ugenRate: 'audio' },
  { rate: 'control', ugen: 'Control', ugenRate: 'control' },
];

const isPVChain = (u: UGen) => u.name === 'FFT' || u.name === 'PackFFT' || u.name.startsWith('PV_');

/** The FFT size a chain UGen's buffer holds (sclang's fftSize). */
function fftSize(g: GraphBuilder, u: UGen): number | Sig {
  if (u.name === 'FFT') {
    const buf = u.inputs[0];
    return new UGen(g, 'BufFrames', 'scalar', [buf], 1, 0, { pure: true }).outputs[0];
  }
  if (u.name === 'PackFFT') return u.inputs[1];
  const src = u.inputs[0];
  if (src instanceof Sig && isPVChain(src.ugen)) return fftSize(g, src.ugen);
  throw new GraphError(`${u.name}: can't tell the FFT size of its chain`);
}

/**
 * sclang's addCopiesIfNeeded: PV UGens process their buffer in place, so when
 * one chain feeds several of them, every consumer but the last gets its own
 * PV_Copy into a fresh LocalBuf, ordered right after the chain.
 */
function addCopiesIfNeeded(g: GraphBuilder): void {
  for (const u of [...g.ugens].sort((a, b) => a.synthIndex - b.synthIndex)) {
    if (!isPVChain(u)) continue;
    const consumers = g.ugens
      .filter((c) => c !== u && c.name !== 'PV_Copy' && g.widthFirst.includes(c) && c.inputs.some((i) => i instanceof Sig && i.ugen === u))
      .sort((a, b) => a.synthIndex - b.synthIndex);
    if (consumers.length < 2) continue;
    const later = g.widthFirst.filter((w) => w.synthIndex > u.synthIndex);
    consumers.slice(0, -1).forEach((c, k) => {
      const base = u.synthIndex + (k + 1) * 0.001;
      const frames = fftSize(g, u);
      const buf = localBuf(g, frames);
      const copy = new UGen(g, 'PV_Copy', 'control', [u.outputs[0], buf], 1, 0, { widthFirst: true });
      const made = [frames instanceof Sig ? frames.ugen : null, buf.ugen, copy].filter((x): x is UGen => x !== null);
      made.forEach((m, j) => {
        m.synthIndex = base + j * 0.0001;
        m.widthFirstAntecedents.length = 0;
        m.widthFirstAntecedents.push(...u.widthFirstAntecedents, u);
      });
      c.inputs = c.inputs.map((i) => (i instanceof Sig && i.ugen === u ? copy.outputs[0] : i));
      // The copy must read the buffer before any later spectral UGen changes it.
      for (const w of later) if (!w.widthFirstAntecedents.includes(copy)) w.widthFirstAntecedents.push(copy);
    });
  }
}

/** Turn a finished graph into SynthDef data + bytes. */
export function finishSynthDef(name: string, g: GraphBuilder): BuiltSynthDef {
  if (name.length > 255) throw new GraphError('SynthDef name too long');
  addCopiesIfNeeded(g);

  // 1. Controls: one Control UGen per rate, laid out contiguously.
  const params: number[] = [];
  const paramNames: { name: string; index: number }[] = [];
  const controls: ControlInfo[] = [];
  const controlUGens: UGen[] = [];
  const placeholders = new Set<UGen>();
  for (const c of g.controls) placeholders.add(c.sigs[0].ugen);

  for (const group of CONTROL_ORDER) {
    const decls = g.controls.filter((c) => c.rate === group.rate);
    if (decls.length === 0) continue;
    const start = params.length;
    const total = decls.reduce((n, d) => n + d.defaults.length, 0);
    const u = new UGen(g, group.ugen, group.ugenRate, [], total, start, { pure: true });
    // sclang builds controls before the graph function runs, so they sort first.
    u.synthIndex = -1000 + controlUGens.length;
    u.widthFirstAntecedents.length = 0;
    let offset = 0;
    for (const d of decls) {
      paramNames.push({ name: d.name, index: params.length });
      controls.push({ name: d.name, rate: d.rate, index: params.length, defaults: d.defaults });
      params.push(...d.defaults.map((v) => Math.fround(v)));
      d.sigs.forEach((sig, i) => {
        sig.ugen = u;
        sig.index = offset + i;
      });
      offset += d.defaults.length;
    }
    controlUGens.push(u);
  }

  // Inputs still pointing at placeholders are rewired through the Sig objects
  // above (inputs hold Sig references), so only the UGen list needs pruning.
  const body = g.ugens.filter((u) => !placeholders.has(u) && !controlUGens.includes(u));

  // 2. Dead-code elimination: keep what side effects depend on.
  const live = new Set<UGen>();
  const stack: UGen[] = body.filter((u) => u.sideEffect);
  if (stack.length === 0) {
    throw new GraphError('SynthDef has no outputs (nothing writes to a bus or has a side effect)');
  }
  while (stack.length) {
    const u = stack.pop()!;
    if (live.has(u)) continue;
    live.add(u);
    for (const i of u.inputs) if (i instanceof Sig && !live.has(i.ugen)) stack.push(i.ugen);
  }
  const kept = [...controlUGens.filter((u) => live.has(u)), ...body.filter((u) => live.has(u))];
  const removed = body.filter((u) => !live.has(u) && !u.pure);
  if (removed.length) {
    g.warn(`unused UGens removed: ${[...new Set(removed.map((u) => u.name))].join(', ')}`);
  }
  // Keep all Control UGens even if no param is read: params must exist so
  // /n_set on them is harmless, and their indices stay stable.
  for (const u of controlUGens) if (!live.has(u)) kept.push(u);
  kept.sort((a, b) => a.synthIndex - b.synthIndex);

  // 3. Topological sort (sclang's algorithm), with side effects kept in creation order.
  const sorted = topoSort(kept);

  // 4. Constants, in order of first appearance.
  const constIndex = new Map<number, number>();
  const constants: number[] = [];
  const keyOf = (n: number) => (Object.is(n, -0) ? 0 : n);
  for (const u of kept) {
    for (const i of u.inputs) {
      if (typeof i === 'number') {
        const k = keyOf(Math.fround(i));
        if (!constIndex.has(k)) {
          constIndex.set(k, constants.length);
          constants.push(k);
        }
      }
    }
  }

  const ugenIndex = new Map<UGen, number>();
  sorted.forEach((u, i) => ugenIndex.set(u, i));

  const ugens: EncodedUGen[] = sorted.map((u) => ({
    name: u.name,
    rate: RATE_CODE[u.rate],
    specialIndex: u.specialIndex,
    inputs: u.inputs.map((i): [number, number] => {
      if (typeof i === 'number') return [-1, constIndex.get(keyOf(Math.fround(i)))!];
      const idx = ugenIndex.get(i.ugen);
      if (idx === undefined) throw new GraphError(`internal: ${describe(i)} feeds ${u.name} but is not in the graph`);
      return [idx, i.index];
    }),
    outputs: u.outputs.map(() => RATE_CODE[u.rate]),
  }));

  const data: SynthDefData = { name, constants, params, paramNames, ugens, variants: [] };
  return { data, bytes: encodeSynthDefs([data]), controls, warnings: g.warnings };
}

/**
 * sclang's SynthDef:topologicalSort — Kahn's algorithm popping from a stack,
 * descendants visited in creation order — plus an edge between consecutive
 * side-effecting UGens so they run in the order they were written.
 */
function topoSort(ugens: UGen[]): UGen[] {
  const set = new Set(ugens);
  const ante = new Map<UGen, Set<UGen>>();
  const desc = new Map<UGen, Set<UGen>>();
  for (const u of ugens) {
    ante.set(u, new Set());
    desc.set(u, new Set());
  }
  const link = (from: UGen, to: UGen) => {
    if (from === to || !set.has(from)) return;
    ante.get(to)!.add(from);
    desc.get(from)!.add(to);
  };
  let lastEffect: UGen | null = null;
  const byCreation = [...ugens].sort((a, b) => a.synthIndex - b.synthIndex);
  for (const u of byCreation) {
    for (const i of u.inputs) if (i instanceof Sig) link(i.ugen, u);
    for (const w of u.widthFirstAntecedents) link(w, u);
    if (u.sideEffect) {
      if (lastEffect) link(lastEffect, u);
      lastEffect = u;
    }
  }
  const descSorted = new Map<UGen, UGen[]>();
  for (const u of ugens) descSorted.set(u, [...desc.get(u)!].sort((a, b) => a.synthIndex - b.synthIndex));

  const available: UGen[] = [];
  for (let i = ugens.length - 1; i >= 0; i--) {
    const u = ugens[i];
    if (ante.get(u)!.size === 0) available.push(u);
  }
  const out: UGen[] = [];
  while (available.length) {
    const u = available.pop()!;
    out.push(u);
    const ds = descSorted.get(u)!;
    for (let i = ds.length - 1; i >= 0; i--) {
      const d = ds[i];
      const a = ante.get(d)!;
      a.delete(u);
      if (a.size === 0) available.push(d);
    }
  }
  if (out.length !== ugens.length) throw new GraphError('internal: cycle in UGen graph');
  return out;
}

// ── SCgf v2 ─────────────────────────────────────────────────────────────────

class Writer {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  i8(v: number) { this.ensure(1); this.view.setInt8(this.pos, v); this.pos += 1; }
  u8(v: number) { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  i16(v: number) { this.ensure(2); this.view.setInt16(this.pos, v); this.pos += 2; }
  i32(v: number) { this.ensure(4); this.view.setInt32(this.pos, v); this.pos += 4; }
  f32(v: number) { this.ensure(4); this.view.setFloat32(this.pos, v); this.pos += 4; }
  pstring(s: string) {
    const bytes = new TextEncoder().encode(s);
    if (bytes.length > 255) throw new GraphError(`name too long: ${s}`);
    this.u8(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export function encodeSynthDefs(defs: SynthDefData[]): Uint8Array {
  const w = new Writer();
  for (const c of 'SCgf') w.u8(c.charCodeAt(0));
  w.i32(2);
  w.i16(defs.length);
  for (const d of defs) {
    w.pstring(d.name);
    w.i32(d.constants.length);
    for (const c of d.constants) w.f32(c);
    w.i32(d.params.length);
    for (const p of d.params) w.f32(p);
    w.i32(d.paramNames.length);
    for (const p of d.paramNames) {
      w.pstring(p.name);
      w.i32(p.index);
    }
    w.i32(d.ugens.length);
    for (const u of d.ugens) {
      w.pstring(u.name);
      w.i8(u.rate);
      w.i32(u.inputs.length);
      w.i32(u.outputs.length);
      w.i16(u.specialIndex);
      for (const [a, b] of u.inputs) {
        w.i32(a);
        w.i32(b);
      }
      for (const r of u.outputs) w.i8(r);
    }
    w.i16(d.variants.length);
    for (const v of d.variants) {
      w.pstring(v.name);
      for (const x of v.values) w.f32(x);
    }
  }
  return w.bytes();
}

export function decodeSynthDefs(bytes: Uint8Array): SynthDefData[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const u8 = () => view.getUint8(pos++);
  const i8 = () => view.getInt8(pos++);
  const i16 = () => { const v = view.getInt16(pos); pos += 2; return v; };
  const i32 = () => { const v = view.getInt32(pos); pos += 4; return v; };
  const f32 = () => { const v = view.getFloat32(pos); pos += 4; return v; };
  const pstring = () => {
    const n = u8();
    const s = new TextDecoder().decode(bytes.subarray(pos, pos + n));
    pos += n;
    return s;
  };
  const magic = String.fromCharCode(u8(), u8(), u8(), u8());
  if (magic !== 'SCgf') throw new Error('not a SynthDef file');
  const version = i32();
  if (version !== 2 && version !== 1) throw new Error(`unsupported SynthDef version ${version}`);
  const n16 = () => (version === 2 ? i32() : i16());
  const count = i16();
  const defs: SynthDefData[] = [];
  for (let d = 0; d < count; d++) {
    const name = pstring();
    const constants = Array.from({ length: n16() }, f32);
    const params = Array.from({ length: n16() }, f32);
    const paramNames = Array.from({ length: n16() }, () => ({ name: pstring(), index: n16() }));
    const ugens: EncodedUGen[] = Array.from({ length: n16() }, () => {
      const uname = pstring();
      const rate = i8();
      const ni = n16();
      const no = n16();
      const specialIndex = i16();
      const inputs = Array.from({ length: ni }, (): [number, number] => [n16(), n16()]);
      const outputs = Array.from({ length: no }, i8);
      return { name: uname, rate, inputs, outputs, specialIndex };
    });
    const variants = version === 2
      ? Array.from({ length: i16() }, () => ({ name: pstring(), values: Array.from({ length: params.length }, f32) }))
      : [];
    defs.push({ name, constants, params, paramNames, ugens, variants });
  }
  return defs;
}

/** Re-export so callers can type inputs without importing ugen.ts. */
export type { Input };
