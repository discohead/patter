// build-catalog.mjs — turn the raw sclang probe output into ugen-catalog.json.
//   node build-catalog.mjs   (reads probe_raw.jsonl, special_raw.jsonl, ops_raw.json, ../engine_ugens.txt)
// Everything about input order / rates / output counts comes from the probes; the hand-written
// parts are (a) the input specs of the UGens listed in OVERRIDES (each one is checked against
// sclang-compiled bytes by verify.mjs) and (b) the prose in SPECIAL, CHECKS and SIDE_EFFECT.
import fs from 'node:fs';
import path from 'node:path';
import { docsFor } from './docs.mjs';

const W = path.dirname(new URL(import.meta.url).pathname);
const readJsonl = (f) => fs.readFileSync(path.join(W, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const rows = readJsonl('probe_raw.jsonl');
const ops = JSON.parse(fs.readFileSync(path.join(W, 'ops_raw.json'), 'utf8'));
const engine = fs.readFileSync(path.join(W, '..', 'engine_ugens.txt'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const engineSet = new Set(engine);

const S = (i) => 1001 + i;                // scalar sentinel of arg i
const E = (i, e) => 2000 + 100 * i + e;   // element e of array sentinel of arg i
const INTERNAL = new Set(['Control', 'AudioControl', 'TrigControl', 'LagControl', 'BinaryOpUGen', 'UnaryOpUGen', 'MulAdd', 'Sum3', 'Sum4']);
const warnings = [];
const warn = (...a) => warnings.push(a.join(' '));

// ---------------------------------------------------------------- decoding helpers
function tokenOf(x, ch, names, { dcIsMine }) {
  if (x.k === 'num') {
    const i = names.findIndex((_, j) => S(j) === x.v);
    if (i >= 0) return { arg: names[i] };
    if (x.v >= 2000 && x.v < 2000 + 100 * names.length) {
      const i2 = Math.floor((x.v - 2000) / 100), e = (x.v - 2000) % 100;
      return { elem: names[i2], e };
    }
    return { const: x.v };
  }
  if ((x.k === 'proxy' || x.k === 'ugen') && x.cls === 'DC' && ch[x.idx]?.inputs?.length === 1 && ch[x.idx].inputs[0].k === 'num') {
    const t = tokenOf(ch[x.idx].inputs[0], ch, names, { dcIsMine });
    if (t.arg || t.elem) return { ...t, viaDC: !dcIsMine, dcRate: ch[x.idx].rate };
    return { ugen: 'DC', dcConst: t.const };
  }
  if (x.k === 'proxy' || x.k === 'ugen') return { ugen: x.cls, out: x.out ?? 0, idx: x.idx };
  return { other: x.cls };
}

// collapse runs of array elements into {arrayArg}
function collapse(tokens) {
  const out = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (t.elem !== undefined) {
      if (last && last.arrayArg === t.elem && last.len === t.e) { last.len++; continue; }
      if (t.e !== 0) { out.push({ bad: `element ${t.elem}[${t.e}] out of order` }); continue; }
      out.push({ arrayArg: t.elem, len: 1, viaDC: t.viaDC });
      continue;
    }
    out.push(t);
  }
  return out;
}

function mainOf(probe, cls) {
  if (!probe || !probe.children) return null;
  const idx = probe.children.findIndex((c) => c.cls === cls);
  return idx < 0 ? null : { idx, ugen: probe.children[idx] };
}

function decodeProbe(probe, cls, names, opts) {
  const m = mainOf(probe, cls);
  if (!m) return null;
  return { ...m, tokens: collapse(m.ugen.inputs.map((x) => tokenOf(x, probe.children, names, opts))) };
}

const sameTok = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- hand-written input specs
// (verified against sclang bytes in verify.mjs)
const I = (name, extra = {}) => ({ arg: name, ...extra });
const OVERRIDES = {
  EnvGen: { inputs: [I('gate'), I('levelScale'), I('levelBias'), I('timeScale'), I('doneAction'), { env: 'envelope', format: 'envgen' }], numOutputs: 1 },
  IEnvGen: { inputs: [I('index'), { env: 'envelope', format: 'ienvgen' }], numOutputs: 1, mulAdd: true },
  Klank: { inputs: [I('input'), I('freqscale'), I('freqoffset'), I('decayscale'), { spec: 'specificationsArrayRef', format: 'klank' }], numOutputs: 1, rate: 'audio' },
  Klang: { inputs: [I('freqscale'), I('freqoffset'), { spec: 'specificationsArrayRef', format: 'klang' }], numOutputs: 1, rate: 'audio' },
  Dwrand: { inputs: [I('repeats'), { arrayLength: 'list' }, { arrayArg: 'weights', extendTo: 'list', pad: 0 }, { arrayArg: 'list' }], numOutputs: 1, rate: 'demand' },
  Dpoll: { inputs: [I('in'), I('trigid'), I('run'), { stringLength: 'label' }, { string: 'label' }], numOutputs: 1, rate: 'demand' },
  Poll: { inputs: [I('trig', { numberToImpulse: true }), I('in'), I('trigid'), { stringLength: 'label' }, { string: 'label' }], numOutputs: 1 },
  SendReply: { inputs: [I('trig'), I('replyID'), { stringLength: 'cmdName' }, { string: 'cmdName' }, { arrayArg: 'values' }], numOutputs: 0 },
  SendPeakRMS: { inputs: [I('replyRate'), I('peakLag'), I('replyID'), { arrayLength: 'sig' }, { arrayArg: 'sig' }, { stringLength: 'cmdName' }, { string: 'cmdName' }], numOutputs: 0 },
  InRect: { inputs: [I('x'), I('y'), I('rect', { field: 'left' }), I('rect', { field: 'top' }), I('rect', { field: 'right' }), I('rect', { field: 'bottom' })], numOutputs: 1 },
  LocalIn: { inputs: [{ arrayArg: 'default', wrapExtend: 'numChannels' }], numOutputs: { arg: 'numChannels' } },
  VarLag: { inputs: [I('in'), I('time'), I('start')], numOutputs: 1, mulAdd: true },
};
const OVERRIDE_RATE = { EnvGen: null, IEnvGen: null, Poll: null, SendReply: null, SendPeakRMS: null, InRect: null, LocalIn: null, VarLag: null };
// nil semantics that the generic nil probe cannot decide (constructor needs other valid args first)
const REQ = { required: true };
const NIL_OVERRIDES = {
  PackFFT: { tobin: { nilMeans: { expr: 'bufsize / 2' } } },
  VarLag: { start: { nilMeans: { arg: 'in' } } },
  Poll: { trig: REQ, label: { nilMeans: { expr: '"UGen(" ++ <sclang class name of in> ++ ")"' } } },
  Dpoll: { in: REQ, label: { nilMeans: { expr: '"DemandUGen(" ++ <sclang class name of in> ++ ")"' } } },
  Klank: { specificationsArrayRef: REQ, input: REQ },
  Klang: { specificationsArrayRef: REQ },
  InRect: { x: REQ, y: REQ, rect: REQ },
  EnvGen: { envelope: REQ },
  IEnvGen: { envelope: REQ, index: REQ },
  Dwrand: { list: REQ, weights: REQ },
  SendReply: { values: { nilMeans: { array: [] } } },
  SendPeakRMS: { sig: REQ },
  DecodeB2: { numChans: REQ },
  PanAz: { numChans: REQ },
};
// constructor shortcuts that return their input instead of creating the UGen
const BYPASS = {
  Lag: { scalarArg: 'in', zeroArg: 'lagTime' }, Lag2: { scalarArg: 'in', zeroArg: 'lagTime' }, Lag3: { scalarArg: 'in', zeroArg: 'lagTime' },
  Ramp: { scalarArg: 'in', zeroArg: 'lagTime' }, VarLag: { scalarArg: 'in', zeroArg: 'time' },
  LagUD: { scalarArg: 'in' }, Lag2UD: { scalarArg: 'in' }, Lag3UD: { scalarArg: 'in' }, Slew: { scalarArg: 'in' },
};

// ---------------------------------------------------------------- semantic tables (judgement, from source)
const CHECKS = {
  Filter: 'sameRateAsFirstInput', LinExp: 'sameRateAsFirstInput', PitchShift: 'sameRateAsFirstInput', Poll: 'sameRateAsFirstInput',
  PulseCount: 'sameRateAsFirstInput', Stepper: 'sameRateAsFirstInput', Timer: 'sameRateAsFirstInput', ZeroCrossing: 'sameRateAsFirstInput',
  TDelay: 'sameRateAsFirstInput', SendTrig: 'sameRateAsFirstInput', Demand: 'sameRateAsFirstInput',
  AmpComp: 'sameRateAsFirstInput(ar only)', InRange: 'sameRateAsFirstInput(ar only)', Hasher: 'sameRateAsFirstInput(ar only)',
  CheckBadValues: 'sameRateAsFirstInput(ar only)', Sanitize: 'sameRateAsFirstInput(ar only)',
  Peak: 'sameRateAsFirstInput, except kr accepts an audio-rate first input',
  Duty: 'if input 0 (dur) is demand-rate, input 1 (reset) must be demand, scalar or the UGen rate',
  Pan2: 'audioRateInputs(0) at ar', Pan4: 'audioRateInputs(0) at ar', PanAz: 'audioRateInputs(0) at ar', PanB: 'audioRateInputs(0) at ar',
  PanB2: 'audioRateInputs(0) at ar', GVerb: 'audioRateInputs(0) at ar',
  Balance2: 'audioRateInputs(0,1) at ar', BiPanB2: 'audioRateInputs(0,1) at ar', Rotate2: 'audioRateInputs(0,1) at ar',
  XFade2: 'audioRateInputs(0,1) at ar', LinXFade2: 'audioRateInputs(0,1) at ar', FreeVerb2: 'audioRateInputs(0,1) at ar',
  InRect: 'audioRateInputs(0,1) at ar', DecodeB2: 'audioRateInputs(0,1,2) at ar',
  BufRd: 'audioRateInputs(1) at ar (phase)', Median: 'audioRateInputs(1) at ar (in)',
  BufWr: 'audioRateInputs(1, 3..) at ar (phase and inputArray)', Select: 'audioRateInputs(1..) at ar (array)',
  T2K: 'input 0 must be audio rate',
};
function checksFor(cls, owner, numFixedArgs) {
  if (owner === 'AbstractOut') return `audioRateInputs(${numFixedArgs}..) at ar (channels); kr needs >= 1 channel`;
  return CHECKS[owner];
}
const SIDE_EFFECT = new Set([
  // bus writes
  'Out', 'ReplaceOut', 'OffsetOut', 'XOut', 'LocalOut', 'SharedOut',
  // messages / posting
  'SendTrig', 'SendReply', 'SendPeakRMS', 'Poll', 'Dpoll', 'CheckBadValues',
  // node control
  'FreeSelf', 'PauseSelf', 'Free', 'Pause', 'FreeSelfWhenDone', 'PauseSelfWhenDone',
  // doneAction can free/pause the node
  'EnvGen', 'Line', 'XLine', 'Linen', 'LFGauss', 'PlayBuf', 'RecordBuf', 'DetectSilence', 'DemandEnvGen', 'Duty', 'TDuty',
  // buffer writes / allocation / synth state
  'BufWr', 'RecordBuf', 'ScopeOut', 'ScopeOut2', 'Dbufwr', 'DelTapWr', 'SetBuf', 'ClearBuf', 'LocalBuf', 'MaxLocalBufs',
  'RandSeed', 'RandID', 'FFT', 'PackFFT',
]);
const isPVWriter = (n) => n.startsWith('PV_') && !['PV_HainsworthFoote', 'PV_JensenAndersen'].includes(n);

// ---------------------------------------------------------------- special descriptions
const SPECIAL = {
  EnvGen: 'EnvGen.ar/kr(envelope, gate=1, levelScale=1, levelBias=0, timeScale=1, doneAction=0). Inputs = [gate, levelScale, levelBias, timeScale, doneAction] ++ envArray (input kind {env, format:"envgen"}). envArray = Env.asArray = [levels[0], numSegments, releaseNode ?? -99, loopNode ?? -99] then for each segment i: [levels[i+1], times[i], shapeNumber(curves.wrapAt(i)), curveValue(curves.wrapAt(i))]. Env.new wraps times to levels.size-1 and defaults curve to \\lin. shapeNumber: step 0, lin/linear 1, exp/exponential 2, sin/sine 3, wel/welch 4, any number 5, sqr/squared 6, cub/cubed 7, hold 8; curveValue = the curve if it is a number/UGen, else 0. Env offset is not used. A plain Array envelope is used verbatim. If any level/time/curve is an Array the Env is multichannel (asMultichannelArray = prAsArray.flop) and one EnvGen per channel is made. Env:kr(doneAction=0, gate=1, timeScale=1, levelScale=1, levelBias=0) and Env:ar take their args in that different order and call EnvGen.',
  IEnvGen: 'IEnvGen.ar/kr(envelope, index, mul=1, add=0). Inputs = [index] ++ Env.asArrayForInterpolation (input kind {env, format:"ienvgen"}) = [offset ?? 0, levels[0], numSegments, sum(times)] then for each segment i: [times[i], shapeNumber(curves.wrapAt(i)), curveValue(curves.wrapAt(i)), levels[i+1]] (shape numbers as for EnvGen); multichannel Envs give one IEnvGen per channel. Then .madd(mul, add).',
  Klank: 'Klank.ar(specificationsArrayRef, input, freqscale=1, freqoffset=0, decayscale=1). The spec is a Ref (`[freqs, amps, ringtimes]); nil amps -> all 1.0, nil ringtimes -> all 1.0. Inputs = [input, freqscale, freqoffset, decayscale] ++ [freqs, amps, ringtimes].flop.flat, i.e. per partial: freq, amp, ringtime (input kind {spec, format:"klank"}). Multichannel: Ref.multichannelExpandRef(2) - if any value inside freqs/amps/ringtimes is itself an Array, the spec is flopDeep(2)-ed and one Klank per channel is made (channel c uses element c, wrapped, of each nested value).',
  Klang: 'Klang.ar(specificationsArrayRef, freqscale=1, freqoffset=0). Spec Ref `[freqs, amps, phases]; nil amps -> 1.0, nil phases -> 0.0. Inputs = [freqscale, freqoffset] ++ [freqs, amps, phases].flop.flat (per partial: freq, amp, phase). Same multichannelExpandRef(2) rule as Klank.',
  Dwrand: 'Dwrand(list, weights, repeats=1): inputs = [repeats, list.size] ++ weights.extend(list.size, 0.0) ++ list (weights padded with 0.0 or truncated to list.size). Demand rate.',
  Dpoll: 'Dpoll(in, label, run=1, trigid=-1): label = label ?? ("DemandUGen(" ++ in.class.name ++ ")"); inputs = [in, trigid, run, label.size] ++ label character codes (ascii), one input per character. Demand rate.',
  Poll: 'Poll.ar/kr(trig, in, label, trigid=-1), Poll(trig, in, label, trigid) and ugen.poll(trig=10, label, trigid=-1). label = label ?? ("UGen(" ++ in.class.name ++ ")") - the class of a MultiOutUGen channel is OutputProxy, giving "UGen(OutputProxy)". A number trig is replaced by Impulse.<rate>(trig, 0) (created after `in`, just before the Poll). Poll.new takes its rate from `in` (scalar -> control). Inputs = [trig, in, trigid, label.size] ++ label ascii codes. The constructor returns `in`, not the Poll.',
  SendReply: 'SendReply.ar/kr(trig=0, cmdName=\'/reply\', values, replyID=-1): if values contains no nested Array it is wrapped ([values]); then [trig, cmdName, values, replyID].flop makes one SendReply per row. Each: inputs = [trig, replyID, cmdName.size] ++ cmdName ascii codes ++ values. 0 outputs; returns 0.',
  SendPeakRMS: 'SendPeakRMS.ar/kr(sig, replyRate=20, peakLag=3, cmdName=\'/reply\', replyID=-1): calls new1 directly, so no multichannel expansion. Inputs = [replyRate, peakLag, replyID, sig.size] ++ sig.flatten ++ [cmdName.size] ++ cmdName ascii codes. 0 outputs; returns 0.',
  InRect: 'InRect.ar/kr(x=0, y=0, rect): rect is an sclang Rect(left, top, width, height); inputs = [x, y, rect.left, rect.top, rect.right (= left + width), rect.bottom (= top + height)].',
  LocalBuf: 'LocalBuf(numFrames=1, numChannels=1), scalar rate, WidthFirstUGen. Inputs = [numChannels, numFrames, <MaxLocalBufs>]. The first LocalBuf of a SynthDef creates one MaxLocalBufs UGen (added to the graph just before that LocalBuf); its single input is the number of LocalBufs in the def (incremented by every LocalBuf, including ones added by PV_Copy insertion), and every LocalBuf takes it as its 3rd input. LocalBuf.newFrom(list) = LocalBuf(list.size, 1) (or shape for 2-D lists) followed by SetBuf(buf, list.flop.flat, 0).',
  MaxLocalBufs: 'Created automatically by the first LocalBuf of a SynthDef (see LocalBuf); scalar rate, one input = total LocalBuf count. Not constructed by user code.',
  LocalIn: 'LocalIn.ar/kr(numChannels=1, default=0): numChannels outputs; inputs = default.asArray.wrapExtend(numChannels), one input per channel with defaults cycled (input kind {arrayArg, wrapExtend}).',
  VarLag: 'VarLag.ar/kr(in=0, time=0.1, curvature=0, warp=5, start, mul=1, add=0). If in.rate == scalar or time == 0: no UGen, returns in.madd(mul, add). Else start = start ? in, curve = Env.shapeNames[warp] ? warp. If curve == 1 (\\lin/\\linear): VarLag UGen with inputs [in, time, start] (curvature and warp are dropped). Otherwise - including the default warp=5 - it builds EnvGen.<rate>(e, trig) with e = Env([start, in], [time], warp).asArray, e[6] = curve, e[7] = curvature, trig = Changed.<rate>(in) + Impulse.<rate>(0) (+ Changed.kr(time) if time is not scalar), where Changed(x) = HPZ1.<rate>(x).abs > 0. Then .madd(mul, add).',
  Lag: 'Lag/Lag2/Lag3/Ramp .ar/.kr: if in.rate == scalar (a number, or a scalar-rate UGen such as Rand or an ir control) or lagTime == 0 (a literal 0), no UGen is created and the result is in.madd(mul, add) (method field "bypass"). LagUD/Lag2UD/Lag3UD/Slew do the same for scalar `in` only. The UGen methods sig.lag/lag2/lag3/lagud/slew/varlag call multiNew directly and never bypass.',
  Dstutter: 'Dstutter(n, in) is deprecated: it returns Ddup(n, in), so the SynthDef contains a "Ddup" unit (serverName Ddup) and the first use posts a warning.',
  Out: 'Out/ReplaceOut/OffsetOut/XOut/LocalOut .ar: channelsArray = UGen.replaceZeroesWithSilence(channelsArray.asUGenInput.asArray): elements equal to 0 are all replaced by ONE shared DC.ar(0) created inside the call (after the other channels, before the Out). .kr variants do not do this. Inputs = fixed args ++ channels; 0 outputs; the constructor returns 0. OffsetOut has no .kr. Nested arrays in channelsArray multichannel-expand into several Outs.',
  asAudioRateInput: 'Inputs marked "audioRate": true (DelayN/L/C, CombN/L/C, AllpassN/L/C, BufDelayN/L/C, BufCombN/L/C, BufAllpassN/L/C and DelTapWr, .ar only) go through asAudioRateInput: a number n becomes DC.ar(n) (0 -> DC.ar(0) via Silent.ar), a non-audio UGen u becomes K2A.ar(u); the converter is created before the UGen.',
  DemandEnvGen: 'DemandEnvGen.ar: if gate or reset is audio rate, the other one is wrapped in K2A.ar when it is not audio rate (K2A created before DemandEnvGen). .kr does no conversion.',
  WhiteNoise: 'WhiteNoise/BrownNoise/PinkNoise/ClipNoise/GrayNoise .ar/.kr: if mul is an Array, one noise UGen per mul element is created (SC2 idiom), then .madd(mul, add).',
  LinXFade2: 'LinXFade2.ar/kr(inA, inB=0, pan=0, level=1): level is not an input; the result is `ugen * level` (BinaryOpUGen *, skipped when level == 1) - method field "postOps".',
  DecodeB2: 'DecodeB2.ar/kr(numChans, w, x, y, orientation=0.5): the orientation argument is ignored - the class library passes `orientation = 0.5` (an assignment), so input 3 is always the constant 0.5.',
  PV_ChainUGen: 'FFT, PV_* and PackFFT are PV_ChainUGens. At SynthDef finish (addCopiesIfNeeded), if one chain UGen is an input of more than one WidthFirstUGen (other than PV_Copy), then for every such consumer except the last (graph order) sclang inserts frames = chain.fftSize (FFT: BufFrames.ir(fft.inputs[0]); PV_*: inputs[0].fftSize; PackFFT: its bufsize input), buf = LocalBuf(frames) (numChannels 1, increments MaxLocalBufs), copy = PV_Copy(chain, buf), rewires that consumer to copy, and places frames/buf/copy directly after the chain UGen.',
  WidthFirstUGen: 'WidthFirstUGens (FFT, IFFT, PV_*, PackFFT, LocalBuf, SetBuf, ClearBuf, RandSeed, RandID; field "widthFirst") are recorded in creation order; every UGen added after one gets all previously created WidthFirstUGens as extra antecedents for the topological sort, so they stay ahead of everything created after them.',
  BinaryOpUGen: 'Internal. Created by math on UGens: BinaryOpUGen(selector, a, b), specialIndex = operator index (field "operators"), rate = demand > audio > control > scalar of the two inputs. new1 folds: a*0/0*b -> 0, *1 -> other, *-1 -> other.neg, +0 -> other, 0-b -> b.neg, a-0 -> a, a/1 -> a, a/-1 -> a.neg. optimizeGraph (pure, dead-code eliminated): for +: Sum3 from (x+y)+z, Sum4 from Sum3+w, MulAdd from (x*y)+z when MulAdd.canBeMulAdd, a + b.neg -> a - b; for -: a - b.neg -> a + b; folded UGens must have exactly one descendant.',
  UnaryOpUGen: 'Internal. UnaryOpUGen(selector, a): specialIndex = operator index (field "operators"), rate = a.rate, pure (dead-code eliminated).',
  MulAdd: 'Internal (not pure: never dead-code eliminated). MulAdd(in, mul=1, add=0) / ugen.madd: mul == 0 -> add; mul == 1 && add == 0 -> in; mul == -1 && add == 0 -> in.neg; add == 0 -> in * mul; mul == -1 -> add - in; mul == 1 -> in + add; else MulAdd(in, mul, add) if canBeMulAdd(in, mul, add), else MulAdd(mul, in, add) if canBeMulAdd(mul, in, add), else (in * mul) + add. canBeMulAdd(in, mul, add) = in is audio rate, or in is control rate and mul and add are control or scalar. Rate = [in, mul, add].rate = alphabetically smallest rate name (audio < control < demand < scalar).',
  Sum3: 'Internal. Sum3(in0, in1, in2): if in2, in1 or in0 == 0 it becomes a + of the other two; otherwise the inputs are reordered by sclang Array.sort {|a b| a.rate < b.rate} (insertion sort): ascending by rate name (audio < control < demand < scalar, numbers are scalar) and inputs of equal rate end up in REVERSE order (Sum3(a, b, c) of three audio UGens is written [c, b, a]). Rate = alphabetically smallest input rate name, as for MulAdd. Created by Mix and by BinaryOpUGen + optimization.',
  Sum4: 'Internal. Sum4(in0..in3): if any input == 0 it becomes a Sum3 of the other three; otherwise inputs are sorted exactly as for Sum3 (ascending rate name, equal rates reversed).',
  Control: 'Internal. Control/AudioControl/TrigControl/LagControl are created by SynthDef from the ugenGraphFunc arguments (and NamedControl): one Control per rate group, specialIndex = index of its first value in the SynthDef controls array; LagControl inputs are the lag times.',
};

// ---------------------------------------------------------------- per-method analysis
function analyseMethod(r, sel, m) {
  const cls = r.class;
  const names = m.argNames;
  const P = m.probes;
  const out = { notes: [] };
  const iMul = names.indexOf('mul'), iAdd = names.indexOf('add');

  // which probe gives the mapping?
  let base = decodeProbe(P.sentinel, cls, names, { dcIsMine: false });
  let viaUgenProbe = false;
  let serverName = cls;
  if (!base && P.ugen) {
    const u = decodeProbe(P.ugen, cls, names, { dcIsMine: true });
    if (u) { base = u; viaUgenProbe = true; }
  }
  if (!base) {
    // constructor creates a differently named UGen (Dstutter -> Ddup)?
    const others = (P.sentinel.children || []).filter((c) => c.cls !== 'DC' && engineSet.has(c.cls));
    if (others.length === 1 && !P.sentinel.err) {
      serverName = others[0].cls;
      base = decodeProbe(P.sentinel, serverName, names, { dcIsMine: false });
    }
  }
  out.serverName = serverName;
  const probeOf = viaUgenProbe ? P.ugen : P.sentinel;
  if (!base) { out.failed = P.sentinel.err || 'constructor created no UGen of this class'; return out; }
  out.rate = base.ugen.rate;
  out.specialIndex = base.ugen.special;
  out.signalRange = base.ugen.signalRange;
  out.check = (P.sentinel.children || []).find((c) => c.cls === cls)?.check ?? null;
  out.ugenCheck = mainOf(P.ugen, cls)?.ugen.check ?? null;

  // mul/add: MulAdd consuming main with the mul/add sentinels
  let mulAdd = false;
  if (iMul >= 0 && iAdd >= 0) {
    const ch = probeOf.children;
    mulAdd = ch.some((c) => c.cls === 'MulAdd' && c.inputs[0] && c.inputs[0].idx === base.idx
      && c.inputs[1]?.k === 'num' && c.inputs[1].v === S(iMul) && c.inputs[2]?.k === 'num' && c.inputs[2].v === S(iAdd));
    if (!mulAdd) out.notes.push('has mul/add args but no MulAdd observed');
  }
  out.mulAdd = mulAdd;
  if (mulAdd) {
    if (iAdd !== iMul + 1) warn(cls, sel, 'mul/add not adjacent');
    if (iMul !== names.length - 2) out.mulAddIndex = iMul;
    const dm = m.defaults[iMul], da = m.defaults[iAdd];
    if (dm !== 1 || da !== 0) warn(cls, sel, `unusual mul/add defaults ${dm}/${da}`);
  }
  // post ops (BinaryOpUGen applied to the output with an arg that is not an input)
  const postOps = [];
  for (const c of probeOf.children) {
    if (c.cls !== 'BinaryOpUGen') continue;
    const [a, b] = c.inputs;
    if (a && a.idx === base.idx && b?.k === 'num') {
      const i = names.findIndex((_, j) => S(j) === b.v);
      if (i >= 0) postOps.push({ op: c.op, arg: names[i] });
    }
  }
  if (postOps.length) out.postOps = postOps;

  // inputs
  const arrayLike = m.arrayLike || [];
  let tokens;
  if (arrayLike.length) {
    const A = decodeProbe(P.finalA, serverName, names, { dcIsMine: false });
    const B = decodeProbe(P.finalB, serverName, names, { dcIsMine: false });
    if (!A || !B) { out.failed = 'final array probes failed: ' + (P.finalA?.err || P.finalB?.err); return out; }
    const lenA = Object.fromEntries(arrayLike.map((n, k) => [n, 3 + 2 * k]));
    const lenB = Object.fromEntries(arrayLike.map((n, k) => [n, 4 + 2 * k]));
    if (A.tokens.length !== B.tokens.length) { out.failed = 'finalA/finalB token count mismatch'; return out; }
    tokens = A.tokens.map((ta, j) => {
      const tb = B.tokens[j];
      if (ta.arrayArg && tb.arrayArg === ta.arrayArg) {
        if (ta.len !== lenA[ta.arrayArg] || tb.len !== lenB[ta.arrayArg]) return { bad: `array ${ta.arrayArg} length ${ta.len}/${tb.len}` };
        return { arrayArg: ta.arrayArg, viaDC: ta.viaDC };
      }
      if (ta.const !== undefined && tb.const !== undefined) {
        if (ta.const === tb.const) return ta;
        const n = arrayLike.find((x) => lenA[x] === ta.const && lenB[x] === tb.const);
        if (n) return { arrayLength: n };
        return { bad: `const ${ta.const}/${tb.const}` };
      }
      if (sameTok(ta, tb)) return ta;
      return { bad: `${JSON.stringify(ta)} vs ${JSON.stringify(tb)}` };
    });
    // numOutputs tied to an array length?
    if (A.ugen.numOutputs !== B.ugen.numOutputs) {
      const n = arrayLike.find((x) => lenA[x] === A.ugen.numOutputs && lenB[x] === B.ugen.numOutputs);
      out.numOutputs = n ? { arrayLength: n } : { bad: `${A.ugen.numOutputs}/${B.ugen.numOutputs}` };
    }
  } else {
    tokens = base.tokens;
  }
  out.inputs = tokens.map((t) => {
    if (t.bad) return { bad: t.bad };
    if (t.arg) {
      const o = { arg: t.arg };
      if (t.viaDC && !viaUgenProbe) o.audioRate = true;
      return o;
    }
    if (t.arrayArg) return { arrayArg: t.arrayArg };
    if (t.arrayLength) return { arrayLength: t.arrayLength };
    if (t.const !== undefined) return { const: t.const };
    if (t.ugen) return { ugen: t.ugen };
    return { bad: JSON.stringify(t) };
  });
  if (out.inputs.some((x) => x.bad)) warn(cls, sel, 'undecodable inputs', JSON.stringify(out.inputs));

  // numOutputs
  if (!out.numOutputs) {
    if (m.numOutArg) {
      const c3 = mainOf(P.chan3, serverName)?.ugen.numOutputs, c2 = mainOf(P.chan2, serverName)?.ugen.numOutputs;
      if (c3 === 3 && c2 === 2) out.numOutputs = { arg: m.numOutArg };
      else out.numOutputs = { bad: `chan3=${c3} chan2=${c2}` };
    } else out.numOutputs = base.ugen.numOutputs;
  }

  // what the constructor returns, when it is not the UGen (or its MulAdd)
  const ret = P.sentinel.ret;
  if (ret.k === 'num' && !viaUgenProbe) {
    const i = names.findIndex((_, j) => S(j) === ret.v);
    if (i >= 0) out.returns = { arg: names[i] };
    else if (ret.v === 0) out.returns = { const: 0 };
    else out.notes.push('returns number ' + ret.v);
  } else if (ret.k === 'proxy' && ret.src === 'DC' && !viaUgenProbe) {
    out.notes.push('returns a DC proxy');
  }

  // which args are inputs at all
  const used = new Set(out.inputs.flatMap((x) => [x.arg, x.arrayArg, x.arrayLength].filter(Boolean)));
  if (out.numOutputs?.arg) used.add(out.numOutputs.arg);
  if (out.numOutputs?.arrayLength) used.add(out.numOutputs.arrayLength);
  if (mulAdd) { used.add('mul'); used.add('add'); }
  for (const p of postOps) used.add(p.arg);
  out.unused = names.filter((n) => !used.has(n));

  // nil-default semantics
  out.nil = {};
  const isArrayArg = (n) => out.inputs.some((x) => x.arrayArg === n);
  names.forEach((n, i) => {
    const np = P['nil_' + n];
    if (!np) return;
    const nm = mainOf(np, serverName);
    const sentPos = base.tokens.map((t, j) => (t.arg === n ? j : -1)).filter((j) => j >= 0);
    if (np.err || !nm) { out.nil[n] = { required: true, why: np.err || 'no ugen' }; return; }
    const chk = nm.ugen.check || '';
    if (/bad input|\( nil \)|: +nil$|missing input/.test(chk)) { out.nil[n] = { required: true, why: chk }; return; }
    if (out.numOutputs?.arg === n && nm.ugen.numOutputs === 0) { out.nil[n] = { required: true, why: 'nil -> 0 outputs' }; return; }
    const nt = collapse(nm.ugen.inputs.map((x) => tokenOf(x, np.children, names, { dcIsMine: false })));
    if (!sentPos.length) { out.nil[n] = { notInput: true }; return; }
    const at = nt[sentPos[0]];
    if (isArrayArg(n) && nt.length === base.tokens.length - 1) { out.nil[n] = { nilMeans: { array: [] } }; return; }
    if (!at) { out.nil[n] = { unknown: 'missing position' }; return; }
    if (at.other) { out.nil[n] = { required: true, why: 'nil input' }; return; }
    if (at.ugen === 'K2A') { out.nil[n] = { required: true, why: 'K2A.ar(nil)' }; return; }
    if (at.arg) { out.nil[n] = { nilMeans: { arg: at.arg } }; return; }
    if (at.const !== undefined) { out.nil[n] = { nilMeans: { const: at.const } }; return; }
    out.nil[n] = { unknown: JSON.stringify(at) };
  });
  return out;
}

// ---------------------------------------------------------------- assemble
const catalog = { _meta: {}, ugens: {}, special: {}, failed: {} };
const fmtDefault = (v) => (v === 'inf' ? 'inf' : v === '-inf' ? '-inf' : v);
const report = [];

for (const r of rows) {
  const cls = r.class;
  const entry = { serverName: cls, methods: {} };
  const anyMethod = Object.values(r.methods)[0];
  const allArgNames = [...new Set(Object.values(r.methods).flatMap((m) => m.argNames || []))].filter((n) => n !== 'mul' && n !== 'add');

  if (INTERNAL.has(cls)) {
    for (const [sel, m] of Object.entries(r.methods)) {
      entry.methods[sel] = { args: m.argNames.map((n, i) => ({ name: n, default: fmtDefault(m.defaults[i] ?? null) })), rate: 'fromInputs' };
      if (m.varArgs) entry.methods[sel].varArgs = true;
    }
    entry.internal = true;
  } else {
    let infos = {};
    for (const [sel, m] of Object.entries(r.methods)) {
      if (m.fatal) { warn(cls, sel, 'fatal', m.fatal); continue; }
      if (/not valid for this subclass/.test(m.probes.sentinel.err || '')) { report.push(`${cls}.${sel}: skipped (shouldNotImplement)`); continue; }
      const a = analyseMethod(r, sel, m);
      infos[sel] = a;
      const ov = OVERRIDES[cls];
      if (ov?.mulAdd !== undefined) a.mulAdd = ov.mulAdd;
      if (a.failed && !ov) { catalog.failed[`${cls}.${sel}`] = a.failed; continue; }
      const argsOut = [];
      m.argNames.forEach((n, i) => {
        if (a.mulAdd && (n === 'mul' || n === 'add')) return;
        const o = { name: n, default: fmtDefault(m.defaults[i] ?? null) };
        const nil = NIL_OVERRIDES[cls]?.[n] ?? a.nil?.[n];
        if (o.default === null && nil) {
          // sclang 3.14 expression defaults (e.g. AmpComp freq = 60.midicps) have a nil
          // prototypeFrame slot; a constant result is reported as the default itself
          if (nil.nilMeans?.const !== undefined) { o.default = nil.nilMeans.const; }
          else if (nil.nilMeans) o.nilMeans = nil.nilMeans;
          else if (nil.required) o.required = true;
          else if (nil.unknown) warn(cls, sel, n, 'nil semantics unknown', nil.unknown);
        }
        argsOut.push(o);
      });
      const mo = { args: argsOut, mulAdd: !!a.mulAdd };
      if (a.mulAddIndex !== undefined) mo.mulAddIndex = a.mulAddIndex;
      let rate = a.rate;
      if (ov && OVERRIDE_RATE[cls] === null) rate = rate ?? (sel === 'ar' ? 'audio' : sel === 'kr' ? 'control' : sel === 'ir' ? 'scalar' : undefined);
      if (ov?.rate) rate = ov.rate;
      if (cls === 'Poll' && sel === 'new') rate = 'fromInputs';
      mo.rate = rate;
      mo.inputs = ov ? ov.inputs : a.inputs;
      mo.numOutputs = ov?.numOutputs ?? a.numOutputs;
      if (a.returns) mo.returns = a.returns;
      if (['SendReply', 'SendPeakRMS'].includes(cls)) mo.returns = { const: 0 };
      if (cls === 'Poll') mo.returns = { arg: 'in' };
      if (BYPASS[cls]) mo.bypass = BYPASS[cls];
      if (a.postOps) mo.postOps = a.postOps;
      entry.methods[sel] = mo;
      if (a.serverName !== cls) entry.serverName = a.serverName;
      if ((a.unused || []).length && !ov) report.push(`${cls}.${sel}: args not used as inputs: ${a.unused.join(',')}`);
      if ((a.notes || []).length) report.push(`${cls}.${sel}: ${a.notes.join('; ')}`);
    }
    const first = Object.values(infos).find((x) => !x.failed) || Object.values(infos)[0];
    if (first?.specialIndex) entry.specialIndex = first.specialIndex;
    const sr = Object.values(infos).map((x) => x.signalRange).find((x) => x && x !== 'ERR');
    if (sr) entry.signalRange = sr;
  }
  if (!entry.signalRange && !INTERNAL.has(cls)) entry.signalRange = 'bipolar';
  const optOwner = r.owners.optimizeGraph?.[0];
  entry.pure = ['PureUGen', 'PureMultiOutUGen', 'UnaryOpUGen', 'BinaryOpUGen'].includes(optOwner);
  entry.sideEffect = SIDE_EFFECT.has(cls) || isPVWriter(cls);
  if (r.isWidthFirst) entry.widthFirst = true;
  const chk = checksFor(cls, r.owners.checkInputs?.[0], r.numFixedArgs);
  if (chk) entry.checks = chk;
  entry.internal = INTERNAL.has(cls);
  if (cls === 'BinaryOpUGen') entry.operators = ops.binary;
  if (cls === 'UnaryOpUGen') entry.operators = ops.unary;
  const d = docsFor(cls, allArgNames);
  if (d.summary) entry.summary = d.summary;
  if (Object.keys(d.argDocs).length) entry.argDocs = d.argDocs;
  if (d.category) entry.category = d.category;
  if (r.file && !r.file.startsWith('/Applications/SuperCollider.app')) entry.source = r.file.includes('LinkUGen') ? 'supersonic test shim (test/synthdefs/sc-classes/LinkUGen.sc)' : 'sc3-plugins';
  catalog.ugens[cls] = entry;
}

// ---------------------------------------------------------------- special map
const SPECIAL_MEMBERS = {
  EnvGen: ['EnvGen'], IEnvGen: ['IEnvGen'], Klank: ['Klank'], Klang: ['Klang'], Dwrand: ['Dwrand'], Dpoll: ['Dpoll'], Poll: ['Poll'],
  SendReply: ['SendReply'], SendPeakRMS: ['SendPeakRMS'], InRect: ['InRect'], LocalBuf: ['LocalBuf'], MaxLocalBufs: ['MaxLocalBufs'],
  LocalIn: ['LocalIn'], VarLag: ['VarLag'], Lag: ['Lag', 'Lag2', 'Lag3', 'Ramp', 'LagUD', 'Lag2UD', 'Lag3UD', 'Slew'], Dstutter: ['Dstutter'],
  Out: ['Out', 'ReplaceOut', 'OffsetOut', 'XOut', 'LocalOut'],
  asAudioRateInput: ['DelayN', 'DelayL', 'DelayC', 'CombN', 'CombL', 'CombC', 'AllpassN', 'AllpassL', 'AllpassC', 'BufDelayN', 'BufDelayL', 'BufDelayC', 'BufCombN', 'BufCombL', 'BufCombC', 'BufAllpassN', 'BufAllpassL', 'BufAllpassC', 'DelTapWr'],
  DemandEnvGen: ['DemandEnvGen'], WhiteNoise: ['WhiteNoise', 'BrownNoise', 'PinkNoise', 'ClipNoise', 'GrayNoise'], LinXFade2: ['LinXFade2'], DecodeB2: ['DecodeB2'],
  PV_ChainUGen: Object.keys(catalog.ugens).filter((n) => n === 'FFT' || n === 'PackFFT' || n.startsWith('PV_')),
  WidthFirstUGen: Object.keys(catalog.ugens).filter((n) => catalog.ugens[n].widthFirst),
  BinaryOpUGen: ['BinaryOpUGen'], UnaryOpUGen: ['UnaryOpUGen'], MulAdd: ['MulAdd'], Sum3: ['Sum3'], Sum4: ['Sum4'],
  Control: ['Control', 'AudioControl', 'TrigControl', 'LagControl'],
};
for (const [k, text] of Object.entries(SPECIAL)) {
  catalog.special[k] = text;
  for (const member of SPECIAL_MEMBERS[k] || [k]) {
    const e = catalog.ugens[member];
    if (!e) { warn('special member missing', member); continue; }
    e.special = e.special ? [...new Set([...[].concat(e.special), k])] : k;
  }
}
for (const e of Object.values(catalog.ugens)) if (Array.isArray(e.special) && e.special.length === 1) e.special = e.special[0];

// ---------------------------------------------------------------- engine names without an sclang class
const SERVER_ONLY = {
  Flip: 'server-only unit (no sclang class in SC 3.14.1 or installed extensions); C++ reads 1 input (in)',
  GrainTap: 'server-only legacy unit; no sclang class in SC 3.14.1',
  SimpleLoopBuf: 'server-only unit; no sclang class in SC 3.14.1',
  UnitCmdDemo: 'server-side demo unit (plugin command example); no sclang class',
  Unwrap: 'server-only unit; no sclang class in SC 3.14.1; C++ reads inputs (in, lo, hi)',
  SPLimiter: 'SuperSonic-only server unit, no sclang class. Per its C++ header: SPLimiter.ar(in, level, lookahead, release) -> 1 output; lookahead must be scalar (not sclang-verified)',
  SPLimiter2: 'SuperSonic-only server unit, no sclang class. Per its C++ header: SPLimiter2.ar(l, r, level, lookahead, release) -> 3 outputs [l, r, gain]; lookahead must be scalar (not sclang-verified)',
};
const covered = new Set(Object.values(catalog.ugens).map((e) => e.serverName).concat(Object.keys(catalog.ugens)));
for (const n of engine) {
  if (!covered.has(n)) catalog.failed[n] = SERVER_ONLY[n] || 'no sclang class found';
}

// ---------------------------------------------------------------- meta
catalog._meta = {
  sclangVersion: '3.14.1',
  generatedAt: new Date().toISOString(),
  count: Object.keys(catalog.ugens).length,
  method: 'sclang probe: every constructor called in an unfinished SynthDef build with per-argument sentinels, array sentinels, nil and UGen-valued arguments (probe.scd); hand-written probes for transforming constructors (probe_special.scd); every method re-checked against sclang SynthDef.asBytes (verify.mjs)',
  sources: 'SCClassLibrary of SuperCollider 3.14.1, plus sc3-plugins DistortionUGens/MdaUGens classes and the SuperSonic LinkUGen.sc test shim',
  inputKinds: {
    arg: '{arg:name} one input from that argument (multichannel-expandable). Optional flags: audioRate (sclang converts with asAudioRateInput, see special.asAudioRateInput), numberToImpulse (Poll trig), field (InRect: left/top/right/bottom of a Rect).',
    arrayArg: '{arrayArg:name} the argument is an array whose elements become consecutive inputs (not expanded). Nested arrays inside it multichannel-expand the UGen. Optional: extendTo/pad (Dwrand weights), wrapExtend (LocalIn default, wrapped to that arg\'s value).',
    arrayLength: '{arrayLength:name} one constant input = size of that array argument.',
    const: '{const:n} constant inserted by sclang regardless of arguments.',
    ugen: '{ugen:Class} input wired to an auxiliary UGen sclang creates (LocalBuf -> MaxLocalBufs).',
    env: '{env:name, format:"envgen"|"ienvgen"} the Env argument flattened into inputs (see special.EnvGen / special.IEnvGen).',
    spec: '{spec:name, format:"klank"|"klang"} Klank/Klang specification Ref flattened (see special).',
    string: '{string:name} one input per ascii code of the String/Symbol argument; {stringLength:name} its length.',
  },
  methodFields: {
    args: 'sclang positional argument order (mul/add removed when mulAdd). default null = nil. "inf" = Infinity. Symbols are strings. nilMeans: what nil turns into ({arg}|{const}|{expr}); required: nil is not allowed.',
    mulAdd: 'the constructor ends with .madd(mul, add) (see special.MulAdd for the degenerate cases); mul/add are not inputs.',
    mulAddIndex: 'present when mul/add are not the last two positional args: index of mul in the full positional list (add follows it).',
    rate: 'rate sclang assigns: audio|control|scalar|demand, or fromInputs.',
    inputs: 'exact SynthDef input order (see inputKinds).',
    numOutputs: 'number, or {arg:name} (value of that argument), or {arrayLength:name}.',
    returns: 'what the constructor returns when it is not the UGen: {const:0} (no usable output) or {arg:name} (returns that argument).',
    bypass: 'constructor shortcut: if scalarArg has scalar rate (number or scalar-rate UGen) or zeroArg == 0, no UGen is made and the result is scalarArg.madd(mul, add).',
    postOps: 'operations applied to the result instead of inputs, e.g. [{op:"*",arg:"level"}] (skipped when the arg is 1).',
  },
  ugenFields: {
    serverName: 'unit name written into the SynthDef (differs only for Dstutter -> Ddup).',
    pure: 'sclang dead-code-eliminates it when nothing reads its output (PureUGen/PureMultiOutUGen/Unary/BinaryOpUGen; DetectSilence opts out).',
    sideEffect: 'judgement: writes buses/buffers, sends messages, frees/pauses nodes (incl. via doneAction) or changes synth state; sclang keeps every non-pure UGen regardless.',
    widthFirst: 'sclang WidthFirstUGen (affects topological sort, see special.WidthFirstUGen).',
    checks: 'rate checks sclang applies at SynthDef build (failure = build error). audioRateInputs(i..) = those inputs must be audio rate when the UGen is audio rate.',
    specialIndex: 'non-zero specialIndex written for the UGen.',
    special: 'key(s) into the top-level special map describing extra sclang behaviour.',
    operators: 'BinaryOpUGen/UnaryOpUGen: operator selector -> specialIndex.',
  },
};

fs.writeFileSync(path.join(W, 'ugen-catalog.json'), JSON.stringify(catalog, null, 1) + '\n');
fs.writeFileSync(path.join(W, 'build-report.txt'), [...warnings.map((w) => 'WARN ' + w), ...report].join('\n') + '\n');
console.log(`ugens=${catalog._meta.count} special=${Object.keys(catalog.special).length} failed=${Object.keys(catalog.failed).length} warnings=${warnings.length}`);
