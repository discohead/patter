// verify.mjs — check every catalog method (and the hand-written special specs) against the bytes
// sclang itself writes (SynthDef.asBytes, i.e. after optimizeGraph + topological sort + writeDef).
//   node verify.mjs gen     -> verify_cases.scd, verify_cases.json
//   HOME=<scratch>/schome sclang --include-path ext-classes verify_cases.scd verify_out.jsonl
//   node verify.mjs check   -> verify_report.txt (exit 1 on any mismatch)
import fs from 'node:fs';
import path from 'node:path';

const W = path.dirname(new URL(import.meta.url).pathname);
const cat = JSON.parse(fs.readFileSync(path.join(W, 'ugen-catalog.json'), 'utf8'));
const f32 = Math.fround;
const RATE_NUM = { scalar: 0, control: 1, audio: 2, demand: 3 };

// ------------------------------------------------------------------ shared JS models of the special specs
// (these are what the compiler author has to implement; verifying them here checks the descriptions)
const SHAPES = { step: 0, lin: 1, linear: 1, exp: 2, exponential: 2, sin: 3, sine: 3, wel: 4, welch: 4, sqr: 6, squared: 6, cub: 7, cubed: 7, hold: 8 };
const shapeNumber = (c) => (typeof c === 'number' ? 5 : SHAPES[c]);
const curveValue = (c) => (typeof c === 'number' ? c : 0);
export function envgenArray({ levels, times, curves = 'lin', releaseNode = null, loopNode = null }) {
  const cs = [].concat(curves), n = times.length, out = [levels[0], n, releaseNode ?? -99, loopNode ?? -99];
  for (let i = 0; i < n; i++) out.push(levels[i + 1], times[i], shapeNumber(cs[i % cs.length]), curveValue(cs[i % cs.length]));
  return out;
}
export function ienvgenArray({ levels, times, curves = 'lin', offset = 0 }) {
  const cs = [].concat(curves), n = times.length, out = [offset ?? 0, levels[0], n, times.reduce((a, b) => a + b, 0)];
  for (let i = 0; i < n; i++) out.push(times[i], shapeNumber(cs[i % cs.length]), curveValue(cs[i % cs.length]), levels[i + 1]);
  return out;
}
const flopFlat = (cols) => cols[0].flatMap((_, i) => cols.map((c) => c[i]));
export const klankSpec = ([f, a, r]) => flopFlat([f, a ?? f.map(() => 1), r ?? f.map(() => 1)]);
export const klangSpec = ([f, a, p]) => flopFlat([f, a ?? f.map(() => 1), p ?? f.map(() => 0)]);
export const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

// ------------------------------------------------------------------ test generation
const scNum = (v) => {
  if (v === Infinity) return 'inf';
  const s = String(v);
  return s.includes('e') ? v.toPrecision(17) : s;
};

function sinkFor(m, expr) {
  if (m.returns || m.numOutputs === 0) return `${expr};`;
  if (m.rate === 'audio') return `Out.ar(0, ${expr});`;
  if (m.rate === 'demand') return `Out.kr(0, Demand.kr(Impulse.kr(1), 0, ${expr}));`;
  return `Out.kr(0, ${expr});`;
}

function genCases() {
  const cases = [];
  for (const [cls, e] of Object.entries(cat.ugens)) {
    if (e.internal) continue;
    for (const [sel, m] of Object.entries(e.methods)) {
      if (m.rate === 'fromInputs') continue;
      const special = m.inputs.some((x) => x.env || x.spec || x.string || x.stringLength || x.extendTo || x.wrapExtend || x.field || x.numberToImpulse);
      if (special || cls === 'VarLag') continue; // covered by the hand-written cases below
      const inputArgs = new Set(m.inputs.filter((x) => x.arg).map((x) => x.arg));
      const arrayArgs = new Set(m.inputs.filter((x) => x.arrayArg || x.arrayLength).map((x) => x.arrayArg || x.arrayLength));
      if (m.numOutputs?.arrayLength) arrayArgs.add(m.numOutputs.arrayLength);
      let k = 0;
      const next = () => 0.25 + 1.125 * k++;
      const vals = {};
      for (const a of m.args) {
        if (m.numOutputs?.arg === a.name) vals[a.name] = 2;
        else if (arrayArgs.has(a.name)) vals[a.name] = [next(), next(), next()];
        else vals[a.name] = next();
      }
      const positional = m.args.map((a) => a.name);
      if (m.mulAdd) {
        vals.mul = 0.6; vals.add = 0.2;
        const at = m.mulAddIndex ?? positional.length;
        positional.splice(at, 0, 'mul', 'add');
      }
      const variants = ['plain'];
      if (cls !== 'DC' && (m.rate === 'audio' || m.rate === 'control')) variants.push('dc', 'dcAudio');
      for (const variant of variants) {
        const wrap = (name, v) => {
          if (variant === 'plain' || !(inputArgs.has(name) || arrayArgs.has(name))) return scNum(v);
          const r = variant === 'dcAudio' || m.rate === 'audio' ? 'ar' : 'kr';
          return `DC.${r}(${scNum(v)})`;
        };
        const argStr = positional.map((n) => {
          const v = vals[n];
          if (Array.isArray(v)) return '[' + v.map((x) => wrap(n, x)).join(', ') + ']';
          return n === 'mul' || n === 'add' ? scNum(v) : wrap(n, v);
        }).join(', ');
        const expr = `${cls}.${sel}(${argStr})`;
        cases.push({ id: `${cls}.${sel}.${variant}`, cls, sel, variant, vals, code: sinkFor(m, expr) });
      }
    }
  }
  return cases.concat(specialCases());
}

// hand-written cases: code + expected inputs of the target UGen (numbers, or {ugen:Name})
function specialCases() {
  const C = [];
  const add = (id, cls, code, expect) => C.push({ id, cls, special: true, code, expect });
  add('EnvGen.kr.special', 'EnvGen', `Out.kr(0, EnvGen.kr(Env([0.11, 0.22, 0.33], [0.44, 0.55], [\\lin, -3.5]), 0.66, 0.77, 0.88, 0.99, 2));`,
    { inputs: [0.66, 0.77, 0.88, 0.99, 2, ...envgenArray({ levels: [0.11, 0.22, 0.33], times: [0.44, 0.55], curves: ['lin', -3.5] })], rate: 'control', numOutputs: 1 });
  add('EnvGen.ar.special-nodes', 'EnvGen', `Out.ar(0, EnvGen.ar(Env([0.11, 0.22, 0.33, 0.44], [0.5, 0.6, 0.7], [\\sine, \\exp, \\welch], 2, 1), 1, 1, 0, 1, 0));`,
    { inputs: [1, 1, 0, 1, 0, ...envgenArray({ levels: [0.11, 0.22, 0.33, 0.44], times: [0.5, 0.6, 0.7], curves: ['sine', 'exp', 'welch'], releaseNode: 2, loopNode: 1 })], rate: 'audio', numOutputs: 1 });
  add('EnvGen.kr.special-shapes', 'EnvGen', `Out.kr(0, EnvGen.kr(Env([0.1, 0.2, 0.3, 0.4, 0.5, 0.6], [1.5, 2.5, 3.5, 4.5, 5.5], [\\step, \\squared, \\cubed, \\hold, \\lin])));`,
    { inputs: [1, 1, 0, 1, 0, ...envgenArray({ levels: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], times: [1.5, 2.5, 3.5, 4.5, 5.5], curves: ['step', 'squared', 'cubed', 'hold', 'lin'] })] });
  add('Env.kr.method', 'EnvGen', `Out.kr(0, Env([0.1, 0.9, 0.2], [0.3, 0.4], -4).kr(2, 0.5, 0.6, 0.7, 0.8));`,
    { inputs: [0.5, 0.7, 0.8, 0.6, 2, ...envgenArray({ levels: [0.1, 0.9, 0.2], times: [0.3, 0.4], curves: -4 })] });
  add('IEnvGen.kr.special', 'IEnvGen', `Out.kr(0, IEnvGen.kr(Env([0.11, 0.22, 0.33], [0.44, 0.55], [\\lin, -3.5], offset: 0.05), 0.66));`,
    { inputs: [0.66, ...ienvgenArray({ levels: [0.11, 0.22, 0.33], times: [0.44, 0.55], curves: ['lin', -3.5], offset: 0.05 })], rate: 'control', numOutputs: 1 });
  add('Klank.ar.special', 'Klank', `Out.ar(0, Klank.ar(\`[[110, 220, 330], [0.5, 0.25, 0.125], [1.5, 2.5, 3.5]], DC.ar(0.1), 1.1, 2.2, 3.3));`,
    { inputs: [{ ugen: 'DC' }, 1.1, 2.2, 3.3, ...klankSpec([[110, 220, 330], [0.5, 0.25, 0.125], [1.5, 2.5, 3.5]])], rate: 'audio', numOutputs: 1 });
  add('Klank.ar.special-nil', 'Klank', `Out.ar(0, Klank.ar(\`[[110, 220], nil, nil], DC.ar(0.1)));`,
    { inputs: [{ ugen: 'DC' }, 1, 0, 1, ...klankSpec([[110, 220], null, null])] });
  add('Klang.ar.special', 'Klang', `Out.ar(0, Klang.ar(\`[[110, 220], [0.5, 0.25], [0.1, 0.2]], 1.1, 2.2));`,
    { inputs: [1.1, 2.2, ...klangSpec([[110, 220], [0.5, 0.25], [0.1, 0.2]])], rate: 'audio', numOutputs: 1 });
  add('Klang.ar.special-nil', 'Klang', `Out.ar(0, Klang.ar(\`[[110, 220, 330]]));`, { inputs: [1, 0, ...klangSpec([[110, 220, 330], null, null])] });
  add('Dwrand.new.special', 'Dwrand', `Out.kr(0, Demand.kr(Impulse.kr(1), 0, Dwrand([11, 12, 13], [0.2, 0.3], 5)));`,
    { inputs: [5, 3, 0.2, 0.3, 0, 11, 12, 13], rate: 'demand', numOutputs: 1 });
  add('Dpoll.new.special', 'Dpoll', `Out.kr(0, Demand.kr(Impulse.kr(1), 0, Dpoll(Dseq([1, 2], inf), "lbl", 1, 7)));`,
    { inputs: [{ ugen: 'Dseq' }, 7, 1, 3, ...ascii('lbl')], rate: 'demand', numOutputs: 1 });
  add('Dpoll.new.special-default', 'Dpoll', `Out.kr(0, Demand.kr(Impulse.kr(1), 0, Dpoll(Dseq([1, 2], inf))));`,
    { inputs: [{ ugen: 'Dseq' }, -1, 1, 16, ...ascii('DemandUGen(Dseq)')] });
  add('Poll.kr.special', 'Poll', `Poll.kr(5, SinOsc.kr(0.5), "abc", 9);`,
    { inputs: [{ ugen: 'Impulse' }, { ugen: 'SinOsc' }, 9, 3, ...ascii('abc')], rate: 'control', numOutputs: 1 });
  add('Poll.ar.special-default', 'Poll', `Poll.ar(Impulse.ar(3), SinOsc.ar(0.5));`,
    { inputs: [{ ugen: 'Impulse' }, { ugen: 'SinOsc' }, -1, 12, ...ascii('UGen(SinOsc)')], rate: 'audio' });
  add('Poll.new.special-proxy', 'Poll', `Poll(4, DC.kr(0.5));`,
    { inputs: [{ ugen: 'Impulse' }, { ugen: 'DC' }, -1, 17, ...ascii('UGen(OutputProxy)')], rate: 'control' });
  add('SendReply.kr.special', 'SendReply', `SendReply.kr(Impulse.kr(1), '/foo', [0.1, 0.2], 42);`,
    { inputs: [{ ugen: 'Impulse' }, 42, 4, ...ascii('/foo'), 0.1, 0.2], rate: 'control', numOutputs: 0 });
  add('SendReply.ar.special-default', 'SendReply', `SendReply.ar(Impulse.ar(1), values: DC.ar(0.5));`,
    { inputs: [{ ugen: 'Impulse' }, -1, 6, ...ascii('/reply'), { ugen: 'DC' }], rate: 'audio', numOutputs: 0 });
  add('SendPeakRMS.kr.special', 'SendPeakRMS', `SendPeakRMS.kr([DC.kr(0.1), DC.kr(0.2)], 15, 2.5, '/rms', 3);`,
    { inputs: [15, 2.5, 3, 2, { ugen: 'DC' }, { ugen: 'DC' }, 4, ...ascii('/rms')], rate: 'control', numOutputs: 0 });
  add('InRect.kr.special', 'InRect', `Out.kr(0, InRect.kr(0.1, 0.2, Rect(0.3, 0.4, 0.5, 0.6)));`,
    { inputs: [0.1, 0.2, 0.3, 0.4, 0.3 + 0.5, 0.4 + 0.6], rate: 'control', numOutputs: 1 });
  add('LocalIn.ar.special', 'LocalIn', `Out.ar(0, LocalIn.ar(3, [0.1, 0.2]));`, { inputs: [0.1, 0.2, 0.1], rate: 'audio', numOutputs: 3 });
  add('LocalIn.kr.special-scalar', 'LocalIn', `Out.kr(0, LocalIn.kr(2, 0.5));`, { inputs: [0.5, 0.5], rate: 'control', numOutputs: 2 });
  add('VarLag.kr.special-lin', 'VarLag', `Out.kr(0, VarLag.kr(DC.kr(0.5), 0.3, 1.5, \\lin, 0.1));`, { inputs: [{ ugen: 'DC' }, 0.3, 0.1], rate: 'control', numOutputs: 1 });
  add('VarLag.kr.special-envgen', 'EnvGen', `Out.kr(0, VarLag.kr(DC.kr(0.5), 0.3, 1.5));`,
    { inputs: [{ ugen: 'BinaryOpUGen' }, 1, 0, 1, 0, { ugen: 'DC' }, 1, -99, -99, { ugen: 'DC' }, 0.3, 5, 1.5] });
  add('LocalBuf.new.special', 'LocalBuf', `Out.kr(0, BufFrames.kr(LocalBuf(1024, 2)));`, { inputs: [2, 1024, { ugen: 'MaxLocalBufs' }], rate: 'scalar', numOutputs: 1 });
  add('MaxLocalBufs.special-count', 'MaxLocalBufs', `Out.kr(0, BufFrames.kr(LocalBuf(1024, 2)) + BufFrames.kr(LocalBuf(512)) + BufFrames.kr(LocalBuf(256)));`, { inputs: [3], rate: 'scalar' });
  add('Lag.kr.special-bypass', null, `Out.kr(0, Lag.kr(0.5, 0.1));`, { absent: 'Lag' });
  add('Lag.kr.special-bypass-zero', null, `Out.kr(0, Lag.kr(DC.kr(0.5), 0));`, { absent: 'Lag' });
  add('Slew.ar.special-bypass', null, `Out.ar(0, Slew.ar(0.5, 1, 1) * DC.ar(1));`, { absent: 'Slew' });
  add('Out.ar.special-zeros', 'Out', `Out.ar(0, [0, DC.ar(0.5), 0]);`, { inputs: [0, { ugen: 'DC', dc: 0 }, { ugen: 'DC', dc: 0.5 }, { ugen: 'DC', dc: 0 }], sharedZero: true });
  add('DelayN.ar.special-number', 'DelayN', `Out.ar(0, DelayN.ar(0.5, 0.2, 0.1));`, { inputs: [{ ugen: 'DC', dc: 0.5 }, 0.2, 0.1] });
  add('DelayN.ar.special-kr', 'DelayN', `Out.ar(0, DelayN.ar(SinOsc.kr(1), 0.2, 0.1));`, { inputs: [{ ugen: 'K2A' }, 0.2, 0.1] });
  add('LinXFade2.ar.special', 'LinXFade2', `Out.ar(0, LinXFade2.ar(DC.ar(0.1), DC.ar(0.2), 0.3, 0.4));`, { inputs: [{ ugen: 'DC' }, { ugen: 'DC' }, 0.3], postMul: 0.4 });
  add('Dstutter.new.special', 'Ddup', `Out.kr(0, Demand.kr(Impulse.kr(1), 0, Dstutter(2, Dseq([1, 2], inf))));`, { inputs: [2, { ugen: 'Dseq' }], rate: 'demand' });
  add('DecodeB2.ar.special', 'DecodeB2', `Out.ar(0, DecodeB2.ar(4, DC.ar(0.1), DC.ar(0.2), DC.ar(0.3), 0.9));`, { inputs: [{ ugen: 'DC' }, { ugen: 'DC' }, { ugen: 'DC' }, 0.5], numOutputs: 4 });
  add('PV_Copy.special-insert', 'PV_Copy', `var c = FFT(LocalBuf(2048), DC.ar(0.1)); Out.ar(0, IFFT(PV_MagFreeze(c, 0.5)) + IFFT(PV_BrickWall(c, 0.2)));`,
    { inputs: [{ ugen: 'FFT' }, { ugen: 'LocalBuf' }], pvCopy: true });
  return C;
}

// ------------------------------------------------------------------ SCgf v2 parser
export function parseSCgf(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const i32 = () => { const v = dv.getInt32(o); o += 4; return v; };
  const i16 = () => { const v = dv.getInt16(o); o += 2; return v; };
  const i8 = () => { const v = dv.getInt8(o); o += 1; return v; };
  const fl = () => { const v = dv.getFloat32(o); o += 4; return v; };
  const pstr = () => { const n = dv.getUint8(o); o += 1; const s = Buffer.from(buf.subarray(o, o + n)).toString('latin1'); o += n; return s; };
  const magic = Buffer.from(buf.subarray(0, 4)).toString('latin1'); o = 4;
  if (magic !== 'SCgf') throw new Error('bad magic ' + magic);
  const version = i32();
  const nDefs = i16();
  const defs = [];
  for (let d = 0; d < nDefs; d++) {
    const name = pstr();
    const consts = Array.from({ length: i32() }, fl);
    const params = Array.from({ length: i32() }, fl);
    const pnames = Array.from({ length: i32() }, () => [pstr(), i32()]);
    const ugens = Array.from({ length: i32() }, () => {
      const u = { name: pstr(), rate: i8() };
      const nIn = i32(), nOut = i32();
      u.special = i16();
      u.inputs = Array.from({ length: nIn }, () => [i32(), i32()]);
      u.outRates = Array.from({ length: nOut }, i8);
      return u;
    });
    const nVar = i16();
    defs.push({ name, consts, params, pnames, ugens, nVar });
  }
  return { version, defs };
}

// ------------------------------------------------------------------ comparison
function resolve(def, [src, idx]) {
  if (src === -1) return { num: def.consts[idx] };
  const u = def.ugens[src];
  if (u.name === 'DC' && u.inputs.length === 1 && u.inputs[0][0] === -1) return { ugen: 'DC', dc: def.consts[u.inputs[0][1]], src, out: idx, rate: u.rate };
  return { ugen: u.name, src, out: idx, rate: u.rate };
}

function expectedFor(c) {
  const e = cat.ugens[c.cls], m = e.methods[c.sel];
  const exp = [];
  for (const x of m.inputs) {
    if (x.arg) {
      const v = c.vals[x.arg];
      if (c.variant !== 'plain') exp.push({ dcOf: v });
      else if (x.audioRate && m.rate === 'audio') exp.push({ dcOf: v });
      else exp.push(v);
    } else if (x.arrayArg) {
      for (const v of c.vals[x.arrayArg]) exp.push(c.variant === 'plain' ? v : { dcOf: v });
    } else if (x.arrayLength) exp.push(c.vals[x.arrayLength].length);
    else if (x.const !== undefined) exp.push(x.const === 'inf' ? Infinity : x.const);
    else if (x.ugen) exp.push({ ugen: x.ugen });
    else exp.push({ unknown: JSON.stringify(x) });
  }
  return exp;
}

function matchInput(want, got) {
  if (typeof want === 'number') return got.num !== undefined && Object.is(f32(want), got.num) || (got.num !== undefined && f32(want) === got.num);
  if (want.dcOf !== undefined) return got.ugen === 'DC' && f32(want.dcOf) === got.dc;
  if (want.ugen) return got.ugen === want.ugen && (want.dc === undefined || f32(want.dc) === got.dc);
  return false;
}
const show = (g) => (g.num !== undefined ? String(g.num) : g.ugen === 'DC' ? `DC(${g.dc})` : `<${g.ugen}>`);

function check() {
  const cases = JSON.parse(fs.readFileSync(path.join(W, 'verify_cases.json'), 'utf8'));
  const outs = new Map(fs.readFileSync(path.join(W, 'verify_out.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  const lines = [];
  const byMethod = new Map();
  let fails = 0;
  for (const c of cases) {
    const r = outs.get(c.id);
    const key = c.special ? c.id : `${c.cls}.${c.sel}`;
    if (!byMethod.has(key)) byMethod.set(key, { ok: 0, built: 0, errs: [], absent: 0 });
    const st = byMethod.get(key);
    if (!r || r.err) { st.errs.push(`${c.variant ?? 'special'}: ${r ? r.err.split('\n')[0] : 'no output'}`); continue; }
    st.built++;
    const def = parseSCgf(Buffer.from(r.hex, 'hex')).defs[0];
    if (c.special && c.expect.absent) {
      if (def.ugens.some((u) => u.name === c.expect.absent)) { fails++; lines.push(`FAIL ${c.id}: ${c.expect.absent} present`); } else st.ok++;
      continue;
    }
    const serverName = c.special ? c.cls : cat.ugens[c.cls].serverName;
    const targets = def.ugens.map((u, i) => [u, i]).filter(([u]) => u.name === serverName);
    const tgt = c.cls === 'DC' ? targets[targets.length - 1] : targets[0];
    if (!tgt) {
      if (!c.special && cat.ugens[c.cls].methods[c.sel].bypass && c.variant === 'plain') { st.absent++; continue; }
      st.errs.push(`${c.variant ?? 'special'}: ${serverName} not in SynthDef`); continue;
    }
    const [u, ui] = tgt;
    const got = u.inputs.map((x) => resolve(def, x));
    const m = c.special ? null : cat.ugens[c.cls].methods[c.sel];
    const want = c.special ? c.expect.inputs : expectedFor(c);
    const problems = [];
    if (want.length !== got.length) problems.push(`input count ${got.length} != ${want.length}`);
    want.forEach((w, i) => { if (got[i] && !matchInput(w, got[i])) problems.push(`in[${i}] got ${show(got[i])} want ${JSON.stringify(w)}`); });
    const rate = c.special ? c.expect.rate : m.rate;
    if (rate && RATE_NUM[rate] !== u.rate) problems.push(`rate ${u.rate} != ${rate}`);
    let nOut = c.special ? c.expect.numOutputs : m.numOutputs;
    if (nOut && typeof nOut === 'object') nOut = nOut.arg ? c.vals[nOut.arg] : c.vals[nOut.arrayLength].length;
    if (nOut !== undefined && nOut !== u.outRates.length) problems.push(`numOutputs ${u.outRates.length} != ${nOut}`);
    const si = c.special ? 0 : cat.ugens[c.cls].specialIndex ?? 0;
    if (u.special !== si) problems.push(`specialIndex ${u.special} != ${si}`);
    if (m?.mulAdd) {
      const mas = def.ugens.filter((x) => x.name === 'MulAdd' && x.inputs[0][0] === ui);
      const expectN = u.outRates.length;
      const okMA = mas.length === expectN && mas.every((x) => f32(0.6) === resolve(def, x.inputs[1]).num && f32(0.2) === resolve(def, x.inputs[2]).num);
      if (!okMA) problems.push(`MulAdd(0.6, 0.2) not found on all ${expectN} outputs (found ${mas.length})`);
    }
    if (m?.postOps || c.expect?.postMul) {
      const lv = c.special ? c.expect.postMul : c.vals[m.postOps[0].arg];
      const bo = def.ugens.find((x) => x.name === 'BinaryOpUGen' && x.special === 2 && x.inputs[0][0] === ui);
      if (!bo || resolve(def, bo.inputs[1]).num !== f32(lv)) problems.push('postOps * level missing');
    }
    if (c.expect?.sharedZero) {
      const zeroRefs = u.inputs.filter((x, i) => got[i].dc === 0).map((x) => x[0]);
      if (new Set(zeroRefs).size !== 1) problems.push('zero channels not one shared DC.ar(0)');
    }
    if (c.expect?.pvCopy) {
      // PV_MagFreeze must read the copy, PV_BrickWall the FFT; MaxLocalBufs counts 2
      const freeze = def.ugens.find((x) => x.name === 'PV_MagFreeze'), brick = def.ugens.find((x) => x.name === 'PV_BrickWall');
      if (def.ugens[freeze.inputs[0][0]].name !== 'PV_Copy' || def.ugens[brick.inputs[0][0]].name !== 'FFT') problems.push('PV_Copy wiring');
      const mlb = def.ugens.find((x) => x.name === 'MaxLocalBufs');
      if (resolve(def, mlb.inputs[0]).num !== 2) problems.push('MaxLocalBufs count != 2');
      const lb2 = def.ugens.filter((x) => x.name === 'LocalBuf')[1];
      if (!lb2 || def.ugens[lb2.inputs[1][0]]?.name !== 'BufFrames' || def.ugens[lb2.inputs[1][0]].rate !== 0) problems.push('copy LocalBuf frames != BufFrames.ir');
    }
    if (problems.length) { fails++; lines.push(`FAIL ${c.id}: ${problems.join('; ')}  got=[${got.map(show).join(', ')}]`); } else st.ok++;
  }
  // every non-internal method must have at least one verified variant
  let verified = 0, unverified = [];
  for (const [key, st] of byMethod) {
    if (st.ok > 0) verified++;
    else { unverified.push(`${key}: ${st.errs.join(' | ')}`); }
  }
  const summary = `methods/cases verified=${verified} unverified=${unverified.length} failures=${fails}`;
  fs.writeFileSync(path.join(W, 'verify_report.txt'), [summary, ...lines, '-- unverified --', ...unverified].join('\n') + '\n');
  console.log(summary);
  if (fails || unverified.length) process.exitCode = 1;
}

function gen() {
  const cases = genCases();
  fs.writeFileSync(path.join(W, 'verify_cases.json'), JSON.stringify(cases));
  // sclang limits selectors/function defs per compiled function, so cases go into chunk files
  const dir = path.join(W, 'verify_chunks');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const CHUNK = 40;
  const chunkFiles = [];
  for (let i = 0; i < cases.length; i += CHUNK) {
    const f = path.join(dir, `chunk_${String(i / CHUNK).padStart(3, '0')}.scd`);
    fs.writeFileSync(f, cases.slice(i, i + CHUNK).map((c) => `~cases.add([${JSON.stringify(c.id)}, { ${c.code} }]);`).join('\n') + '\n');
    chunkFiles.push(f);
  }
  const sc = [
    '// generated by verify.mjs gen — builds one SynthDef per case and writes its bytes (hex)',
    '(',
    'var out = File(thisProcess.argv[0], "w");',
    '~cases = List.new;',
    `${JSON.stringify(chunkFiles)}.do { |f| thisProcess.interpreter.executeFile(f) };`,
    'protect {',
    '  ~cases.do { |c, i|',
    '    var sd, err, hex;',
    '    sd = { Exception.inProtectedFunction = false; SynthDef(("v" ++ i).asSymbol, c[1]) }.try({ |e| err = e.errorString; nil });',
    '    if(sd.notNil) { hex = { Exception.inProtectedFunction = false; sd.asBytes.collect { |b| (b & 255).asHexString(2) }.join }.try({ |e| err = "asBytes: " ++ e.errorString; nil }) };',
    '    if(hex.notNil) { out.write("{\\"id\\":\\"" ++ c[0] ++ "\\",\\"hex\\":\\"" ++ hex ++ "\\"}\\n") } {',
    '      out.write("{\\"id\\":\\"" ++ c[0] ++ "\\",\\"err\\":\\"" ++ (err ? "?").asString.reject { |ch| (ch == $") or: { ch == $\\\\ } or: { ch.ascii < 32 } } ++ "\\"}\\n")',
    '    };',
    '  };',
    '} { out.close; "VERIFY DONE".postln; 0.exit };',
    ')',
  ];
  fs.writeFileSync(path.join(W, 'verify_cases.scd'), sc.join('\n') + '\n');
  console.log(`cases=${cases.length} chunks=${chunkFiles.length}`);
}

if (process.argv[2] === 'gen') gen();
else if (process.argv[2] === 'check') check();
