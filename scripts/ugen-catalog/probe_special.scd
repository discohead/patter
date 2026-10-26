// probe_special.scd — hand-written probes, with valid arguments, for the UGens whose
// sclang constructors transform their arguments (EnvGen, Klank, SendReply, LocalBuf, ...).
// For each case it records the raw (unoptimised) graph and, where useful, the finished
// SynthDef (after optimizeGraph / PV_Copy insertion / topological sort).
//   HOME=<scratch>/schome sclang --include-path <dir>/ext-classes probe_special.scd <out.jsonl>
(
var outPath = thisProcess.argv[0];
var outFile, jstr, json, descInput, descUGen, descRet, raw, finished, cases, safe;

jstr = { |s|
	var out = List.new;
	s.asString.do { |ch|
		case
		{ ch == $" } { out.add("\\\"") }
		{ ch == $\\ } { out.add("\\\\") }
		{ ch == $\n } { out.add("\\n") }
		{ ch == $\t } { out.add("\\t") }
		{ ch.ascii < 32 } { out.add(" ") }
		{ true } { out.add(ch.asString) };
	};
	"\"" ++ out.join ++ "\""
};
json = { |obj|
	case
	{ obj.isNil } { "null" }
	{ obj === true } { "true" }
	{ obj === false } { "false" }
	{ obj.isKindOf(Integer) } { obj.asString }
	{ obj.isKindOf(Float) } {
		case
		{ obj.isNaN } { "\"nan\"" }
		{ obj == inf } { "\"inf\"" }
		{ obj == -inf } { "\"-inf\"" }
		{ true } { obj.asStringPrec(17) }
	}
	{ obj.isKindOf(Symbol) } { jstr.(obj.asString) }
	{ obj.isKindOf(String) } { jstr.(obj) }
	{ obj.isKindOf(Dictionary) } {
		"{" ++ obj.keys.asArray.collect(_.asString).sort.collect { |k|
			jstr.(k) ++ ":" ++ json.(obj[k.asSymbol])
		}.join(",") ++ "}"
	}
	{ obj.isKindOf(SequenceableCollection) } { "[" ++ obj.asArray.collect { |x| json.(x) }.join(",") ++ "]" }
	{ true } { jstr.("<" ++ obj.class.name.asString ++ ">") }
};
safe = { |f, default| { Exception.inProtectedFunction = false; f.value }.try({ |e| default }) };

descInput = { |in, children|
	case
	{ in.isKindOf(OutputProxy) } { (k: "proxy", cls: in.source.class.name, idx: children.indexOf(in.source), out: in.outputIndex) }
	{ in.isKindOf(UGen) } { (k: "ugen", cls: in.class.name, idx: children.indexOf(in)) }
	{ in.isNumber } { (k: "num", v: in) }
	{ true } { (k: "other", cls: in.class.name) }
};
descUGen = { |u, children|
	var d = (cls: u.class.name, rate: u.rate, numOutputs: safe.({ u.numOutputs }, -1), special: u.specialIndex,
		inputs: (u.inputs ? []).collect { |in| descInput.(in, children) });
	if(u.isKindOf(BasicOpUGen)) { d[\op] = u.operator };
	d
};
descRet = { |r|
	case
	{ r.isNil } { (k: "nil") }
	{ r.isKindOf(OutputProxy) } { (k: "proxy", src: r.source.class.name, out: r.outputIndex) }
	{ r.isKindOf(UGen) } { (k: "ugen", cls: r.class.name) }
	{ r.isNumber } { (k: "num", v: r) }
	{ r.isKindOf(Array) } { (k: "array", size: r.size, items: r.collect { |x| descRet.(x) }) }
	{ true } { (k: "other", cls: r.class.name) }
};

// unoptimised graph of one function evaluated in a build context
raw = { |func|
	var sd, ret, err, children, res;
	sd = SynthDef.newCopyArgs(\probe);
	sd.children = Array(64);
	sd.metadata = ();
	sd.initBuild;
	ret = { Exception.inProtectedFunction = false; func.value }.try({ |e| err = e.errorString; nil });
	UGen.buildSynthDef = nil;
	children = sd.children.select(_.notNil);
	res = (ret: descRet.(ret), children: children.collect { |u| descUGen.(u, children) });
	if(err.notNil) { res[\err] = err };
	res
};
// finished SynthDef (optimised, sorted) — children in final file order
finished = { |func|
	var sd, err, res;
	sd = { Exception.inProtectedFunction = false; SynthDef(\probe, func) }.try({ |e| err = e.errorString; nil });
	if(sd.isNil) { (err: err) } {
		res = (children: sd.children.collect { |u| descUGen.(u, sd.children) });
		res[\bytesHex] = sd.asBytes.collect { |b| (b & 255).asHexString(2) }.join;
		res
	}
};

cases = [
	// --- EnvGen / IEnvGen ---
	\envgen_basic, { EnvGen.kr(Env([0.11, 0.22, 0.33], [0.44, 0.55], [\lin, -3.5]), 0.66, 0.77, 0.88, 0.99, 2) }, nil,
	\envgen_nodes, { EnvGen.kr(Env([0.11, 0.22, 0.33, 0.44], [0.5, 0.6, 0.7], \sine, 2, 1)) }, nil,
	\envgen_shapes, { EnvGen.kr(Env([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], [1, 2, 3, 4, 5, 6, 7], [\step, \exp, \welch, \squared, \cubed, \hold, 2.5])) }, nil,
	\envgen_offset, { EnvGen.kr(Env([0.11, 0.22], [0.33], \lin, nil, nil, 0.5)) }, nil,
	\envgen_rawarray, { EnvGen.kr([0.1, 2, -99, -99, 0.2, 0.3, 1, 0, 0.4, 0.5, 1, 0], 0.66) }, nil,
	\envgen_multichan, { EnvGen.kr(Env([0.1, [0.2, 0.3]], [0.4])) }, nil,
	\envgen_ugenlevel, { EnvGen.ar(Env([0, DC.kr(0.5), 0], [0.1, 0.2]), DC.kr(1)) }, nil,
	\env_kr_method, { Env([0.1, 1, 0.2], [0.3, 0.4]).kr(2, 0.5, 0.6, 0.7, 0.8) }, nil,
	\env_ar_method, { Env([0.1, 1, 0.2], [0.3, 0.4]).ar(2, 0.5, 0.6, 0.7, 0.8) }, nil,
	\ienvgen_basic, { IEnvGen.kr(Env([0.11, 0.22, 0.33], [0.44, 0.55], [\lin, -3.5], offset: 0.05), DC.kr(0.66)) }, nil,
	\ienvgen_madd, { IEnvGen.ar(Env([0.11, 0.22], [0.33], \exp), DC.ar(0.66), 0.5, 0.25) }, nil,
	// --- Klank / Klang ---
	\klank_full, { Klank.ar(`[[110, 220], [0.5, 0.25], [1.5, 2.5]], DC.ar(0.1), 1.1, 2.2, 3.3) }, nil,
	\klank_nil, { Klank.ar(`[[110, 220], nil, nil], DC.ar(0.1)) }, nil,
	\klank_multi, { Klank.ar(`[[[110, 220], [330, 440]], [0.5, 0.25], [1.5, 2.5]], DC.ar(0.1)) }, nil,
	\klang_full, { Klang.ar(`[[110, 220], [0.5, 0.25], [0.1, 0.2]], 1.1, 2.2) }, nil,
	\klang_nil, { Klang.ar(`[[110, 220, 330]]) }, nil,
	// --- demand-rate oddities ---
	\dwrand, { Dwrand([11, 12, 13], [0.2, 0.3], 5) }, nil,
	\dpoll_label, { Dpoll(Dseq([1, 2], inf), "lbl", 1, 7) }, nil,
	\dpoll_default, { Dpoll(Dseq([1, 2], inf)) }, nil,
	\dstutter, { Dstutter(2, Dseq([1, 2], inf)) }, nil,
	\demand_multi, { Demand.kr(Impulse.kr(1), 0, [Dseq([1, 2], inf), Dwhite(0, 1, inf)]) }, nil,
	\demandenvgen_audiogate, { DemandEnvGen.ar(Dseq([1, 2], inf), Dseq([0.1], inf), 1, 0, DC.ar(1), 1) }, nil,
	\duty_demand, { Duty.kr(Dseq([0.1, 0.2], inf), 0, Dseq([1, 2], inf), 2) }, nil,
	// --- Poll / SendReply / SendPeakRMS ---
	\poll_kr, { Poll.kr(5, DC.kr(0.5), "abc", 9) }, nil,
	\poll_ar_default, { Poll.ar(Impulse.ar(3), DC.ar(0.5)) }, nil,
	\poll_new_scalar, { Poll(4, Rand(0, 1)) }, nil,
	\poll_method, { DC.kr(0.5).poll(7, "x") }, nil,
	\sendreply_kr, { SendReply.kr(Impulse.kr(1), '/foo', [DC.kr(0.1), DC.kr(0.2)], 42) }, nil,
	\sendreply_nested, { SendReply.kr(Impulse.kr(1), '/foo', [[DC.kr(0.1), DC.kr(0.2)], [DC.kr(0.3), DC.kr(0.4)]], [1, 2]) }, nil,
	\sendreply_default, { SendReply.ar(Impulse.ar(1), values: DC.ar(0.5)) }, nil,
	\sendpeakrms, { SendPeakRMS.kr([DC.kr(0.1), DC.kr(0.2)], 15, 2.5, '/rms', 3) }, nil,
	// --- InRect ---
	\inrect, { InRect.kr(DC.kr(0.1), DC.kr(0.2), Rect(0.3, 0.4, 0.5, 0.6)) }, nil,
	// --- LocalBuf / SetBuf / MaxLocalBufs ---
	\localbuf_two, { [LocalBuf(1024, 2), LocalBuf(512)] }, { Out.kr(0, [BufFrames.kr(LocalBuf(1024, 2)), BufFrames.kr(LocalBuf(512))]) },
	\localbuf_newfrom, { LocalBuf.newFrom([0.1, 0.2, 0.3]) }, { Out.kr(0, BufFrames.kr(LocalBuf.newFrom([0.1, 0.2, 0.3]))) },
	\setbuf, { SetBuf(LocalBuf(4), [0.1, 0.2, 0.3], 1) }, nil,
	\clearbuf, { ClearBuf(LocalBuf(4)) }, nil,
	// --- LocalIn ---
	\localin_array, { LocalIn.ar(2, [0.1, 0.2]) }, nil,
	\localin_scalar, { LocalIn.ar(3, 0.5) }, nil,
	\localin_wrap, { LocalIn.kr(3, [0.1, 0.2]) }, nil,
	\localin_default, { LocalIn.ar(2) }, nil,
	// --- Lag family shortcuts / VarLag ---
	\lag_scalar, { Lag.kr(0.5, 0.1) }, nil,
	\lag_zero, { Lag.kr(DC.kr(0.5), 0) }, nil,
	\lag_ugen, { Lag.kr(DC.kr(0.5), 0.1, 2, 1) }, nil,
	\lag_scalar_ugen, { Lag.kr(Rand(0, 1), 0.1) }, nil,
	\lagud_scalar, { LagUD.kr(0.5, 0.1, 0.2) }, nil,
	\slew_scalar, { Slew.ar(0.5, 1, 1) }, nil,
	\varlag_lin, { VarLag.kr(DC.kr(0.5), 0.3, 1.5, \lin, 0.1) }, nil,
	\varlag_default, { VarLag.kr(DC.kr(0.5), 0.3, 1.5) }, nil,
	\varlag_exp_ugentime, { VarLag.ar(DC.ar(0.5), DC.kr(0.3), 0, \exp) }, nil,
	\ugen_lag_method, { DC.kr(0.5).lag(0.1) }, nil,
	// --- asAudioRateInput ---
	\delay_number, { DelayN.ar(0.5, 0.2, 0.1) }, nil,
	\delay_zero, { DelayN.ar(0, 0.2, 0.1) }, nil,
	\delay_kr, { DelayN.ar(DC.kr(0.5), 0.2, 0.1) }, nil,
	\comb_kr, { CombN.ar(DC.kr(0.5), 0.2, 0.1, 1) }, nil,
	\deltapwr_number, { DelTapWr.ar(LocalBuf(1024), 0.5) }, nil,
	// --- Out family zero replacement ---
	\out_zeros, { Out.ar(0, [0, DC.ar(0.5), 0]) }, { Out.ar(0, [0, DC.ar(0.5), 0]) },
	\out_zero_scalar, { Out.ar(3, 0) }, nil,
	\out_kr_zero, { Out.kr(3, [0, DC.kr(0.5)]) }, nil,
	\xout_zero, { XOut.ar(0, 0.5, [0, DC.ar(0.5)]) }, nil,
	\localout_zero, { LocalOut.ar([0, DC.ar(0.5)]) }, nil,
	\out_bad_rate, { Out.ar(0, DC.kr(0.5)) }, { Out.ar(0, DC.kr(0.5)) },
	// --- FFT chains ---
	\fft_chain_copy, { var c = FFT(LocalBuf(2048), DC.ar(0.1)); [IFFT(PV_MagFreeze(c, 0.5)), IFFT(PV_BrickWall(c, 0.2))] },
		{ var c = FFT(LocalBuf(2048), DC.ar(0.1)); Out.ar(0, IFFT(PV_MagFreeze(c, 0.5)) + IFFT(PV_BrickWall(c, 0.2))) },
	\fft_simple, { IFFT(PV_MagFreeze(FFT(LocalBuf(1024), DC.ar(0.1)), 0.5)) }, { Out.ar(0, IFFT(PV_MagFreeze(FFT(LocalBuf(1024), DC.ar(0.1)), 0.5))) },
	\packfft, { PackFFT(FFT(LocalBuf(512), DC.ar(0.1)), 512, [0.1, 0.2, 0.3, 0.4], 0, nil, 1) }, nil,
	\unpack1fft, { Unpack1FFT(FFT(LocalBuf(512), DC.ar(0.1)), 512, 3, 1) }, nil,
	// --- misc ---
	\linxfade2, { LinXFade2.ar(DC.ar(0.1), DC.ar(0.2), 0.3, 0.4) }, nil,
	\linxfade2_level1, { LinXFade2.ar(DC.ar(0.1), DC.ar(0.2), 0.3) }, nil,
	\decodeb2, { DecodeB2.ar(4, DC.ar(0.1), DC.ar(0.2), DC.ar(0.3), 0.9) }, nil,
	\whitenoise_mularray, { WhiteNoise.ar([0.1, 0.2]) }, nil,
	\sinosc_muladd, { SinOsc.ar(440, 0, 0.5, 0.25) }, { Out.ar(0, SinOsc.ar(440, 0, 0.5, 0.25)) },
	\sinosc_mul, { SinOsc.ar(440, 0, 0.5) }, { Out.ar(0, SinOsc.ar(440, 0, 0.5)) },
	\sinosc_add, { SinOsc.ar(440, 0, 1, 0.5) }, { Out.ar(0, SinOsc.ar(440, 0, 1, 0.5)) },
	\sinosc_kr_muladd_ar, { SinOsc.kr(1, 0, DC.ar(0.5), 0.25) }, nil,
	\pan2_madd_none, { Pan2.ar(DC.ar(0.1), 0.2, 0.3) }, nil,
	\freeself_ret, { FreeSelf.kr(DC.kr(1)) }, nil,
	\randseed, { RandSeed.kr(1, 123) }, { RandSeed.kr(1, 123); Out.ar(0, WhiteNoise.ar) },
	\filter_kr_scalar, { LPF.kr(0.5, 100) }, { Out.kr(0, LPF.kr(0.5, 100)) },
	\filter_ar_kr, { LPF.ar(DC.kr(0.5), 100) }, { Out.ar(0, LPF.ar(DC.kr(0.5), 100)) },
	\gendy_knum_nil, { Gendy1.ar(1, 1, 1, 1, 440, 660, 0.5, 0.5, 9) }, nil,
	\stepper_resetval_nil, { Stepper.kr(DC.kr(1), 0, 2, 9, 1) }, nil,
	\scopeout2_nil, { ScopeOut2.ar([DC.ar(0.1)], 1, 2048) }, nil,
	\tgrains_1ch, { TGrains.ar(1, Impulse.ar(1), 0, 1, 0, 0.1) }, nil,
	\in_multi, { In.ar([0, 2], 2) }, nil,
	\playbuf_nil, { PlayBuf.ar(nil, 0) }, nil,
	\select_array, { Select.ar(DC.ar(1), [DC.ar(0.1), DC.ar(0.2)]) }, nil,
	\twindex, { TWindex.kr(Impulse.kr(1), [0.2, 0.3, 0.5], 1) }, nil,
	\dc_array, { DC.ar([0.1, 0.2]) }, nil,
	\mix_sum3, { Mix([DC.ar(0.1), DC.ar(0.2), DC.ar(0.3)]) }, { Out.ar(0, Mix([DC.ar(0.1), DC.ar(0.2), DC.ar(0.3)])) },
	\mix_sum4, { Mix([DC.ar(0.1), DC.ar(0.2), DC.ar(0.3), DC.ar(0.4)]) }, { Out.ar(0, Mix([DC.ar(0.1), DC.ar(0.2), DC.ar(0.3), DC.ar(0.4)])) },
	\mul_add_opt, { (DC.ar(0.1) * DC.kr(0.2)) + DC.kr(0.3) }, { Out.ar(0, (DC.ar(0.1) * DC.kr(0.2)) + DC.kr(0.3)) }
];

outFile = File(outPath, "w");
protect {
	cases.clump(3).do { |c|
		var name = c[0], rawFunc = c[1], finFunc = c[2], rec;
		("case " ++ name).postln;
		rec = (name: name, raw: raw.(rawFunc));
		if(finFunc.notNil) { rec[\finished] = finished.(finFunc) };
		outFile.write(json.(rec) ++ "\n");
		outFile.flush;
	};
} {
	outFile.close;
	"SPECIAL DONE".postln;
	0.exit;
};
)
