// probe.scd — empirically probe every sclang UGen class whose server-side name is in
// engine_ugens.txt and dump raw observations as JSON lines (one class per line).
//
// Usage (never boots a server; HOME override keeps the user's startup.scd out):
//   HOME=<scratch>/schome sclang --include-path <dir>/ext-classes probe.scd <engine_ugens.txt> <out.jsonl>
//
// Probes per constructor method (ar/kr/ir/new):
//   defaults : call with no args (sclang defaults)
//   sentinel : every arg gets a distinct scalar sentinel 1001+i (mul/add too)
//   array_<a>: arg a gets [2000+100i, 2001+100i, 2002+100i], other args sentinels
//   nil_<a>  : arg a (whose default is nil) passed nil explicitly, others sentinels
//   finalA/B : every "array-like" arg (one instance, its elements inlined) gets arrays of
//              length 3+2k (A) / 4+2k (B), others sentinels -> decode arrayLength consts
//   chan3    : the arg whose sentinel equalled numOutputs is set to 3
// Each probe records every UGen added to the (unoptimised) graph, in creation order.
(
var enginePath = thisProcess.argv[0];
var outPath = thisProcess.argv[1];
var onlyNames = thisProcess.argv[2] !? { |s| s.split($,).collect(_.asSymbol) };
var engineNames, internal, classes, outFile;
var jstr, json, probe, descInput, descUGen, descRet, isUGenClass, methodInfo, sentinelFor, elemFor;
var mainOf, classInfo, probeMethod, safe;

internal = #[\Control, \AudioControl, \TrigControl, \LagControl, \BinaryOpUGen, \UnaryOpUGen, \MulAdd, \Sum3, \Sum4];

engineNames = File.readAllString(enginePath).split($\n)
	.collect { |s| s.reject { |c| c.isSpace } }
	.reject { |s| s.size == 0 }
	.collect(_.asSymbol).asSet;

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
	{ obj.isKindOf(Char) } { jstr.(obj.asString) }
	{ obj.isKindOf(Dictionary) } {
		"{" ++ obj.keys.asArray.collect(_.asString).sort.collect { |k|
			jstr.(k) ++ ":" ++ json.(obj[k.asSymbol] ?? { obj[k] })
		}.join(",") ++ "}"
	}
	{ obj.isKindOf(SequenceableCollection) } { "[" ++ obj.asArray.collect { |x| json.(x) }.join(",") ++ "]" }
	{ true } { jstr.("<" ++ obj.class.name.asString ++ ":" ++ obj.asCompileString ++ ">") }
};

// NB: every try body first clears Exception.inProtectedFunction so that Exception.new does not
// capture a backtrace (getBackTrace); with captured frames sclang 3.14.1 was observed to lose
// return values of enclosing functions (e.g. a try returning nil instead of its body's value).
safe = { |f, default| { Exception.inProtectedFunction = false; f.value }.try({ |e| default }) };

isUGenClass = { |cls| cls.notNil and: { cls === UGen or: { (cls.superclasses ? []).includes(UGen) } } };

sentinelFor = { |i| 1001 + i };
elemFor = { |i, e| 2000 + (100 * i) + e };

descInput = { |in, children|
	case
	{ in.isKindOf(OutputProxy) } {
		(k: "proxy", cls: in.source.class.name, idx: children.indexOf(in.source), out: in.outputIndex, rate: in.rate)
	}
	{ in.isKindOf(UGen) } { (k: "ugen", cls: in.class.name, idx: children.indexOf(in), rate: in.rate) }
	{ in.isNumber } { (k: "num", v: in) }
	{ true } { (k: "other", cls: in.class.name, v: safe.({ in.asCompileString }, "?")) }
};

descUGen = { |u, children, full|
	var chk, d = (
		cls: u.class.name,
		rate: u.rate,
		inputs: (u.inputs ? []).collect { |in| descInput.(in, children) },
		numOutputs: safe.({ u.numOutputs }, -1),
		special: u.specialIndex
	);
	if(u.isKindOf(BasicOpUGen)) { d[\op] = u.operator };
	if(full) {
		d[\signalRange] = safe.({ u.signalRange }, "ERR");
		chk = { Exception.inProtectedFunction = false; u.checkInputs }.try({ |e| "THROW: " ++ e.errorString });
		d[\check] = chk;
		d[\writesToBus] = safe.({ u.writesToBus }, "ERR");
		if(u.isKindOf(MultiOutUGen)) {
			d[\channelRates] = safe.({ u.channels.collect(_.rate) }, nil);
		};
	};
	d
};

descRet = { |r|
	case
	{ r.isNil } { (k: "nil") }
	{ r.isKindOf(OutputProxy) } { (k: "proxy", src: r.source.class.name, out: r.outputIndex) }
	{ r.isKindOf(UGen) } { (k: "ugen", cls: r.class.name) }
	{ r.isNumber } { (k: "num", v: r) }
	{ r.isKindOf(Array) } { (k: "array", size: r.size, items: r.keep(4).collect { |x| descRet.(x) }) }
	{ true } { (k: "other", cls: r.class.name) }
};

// run one constructor call inside a fresh, never-finished SynthDef build
probe = { |cls, sel, argVals|
	var sd, ret, err, res, children, mains;
	sd = SynthDef.newCopyArgs(\probe);
	sd.children = Array(64);
	sd.metadata = ();
	sd.initBuild;
	if(argVals.isKindOf(Function)) { argVals = argVals.value };
	ret = { Exception.inProtectedFunction = false; cls.performList(sel, argVals) }.try({ |e| err = e; nil });
	UGen.buildSynthDef = nil;
	children = sd.children.select(_.notNil);
	res = (
		ret: descRet.(ret),
		children: children.collect { |u| descUGen.(u, children, u.class === cls) }
	);
	if(err.notNil) { res[\err] = (err.errorString ? err.class.name.asString) };
	mains = children.select { |u| u.class === cls };
	res[\mainCount] = mains.size;
	(res: res, mains: mains)
};

methodInfo = { |cls, sel|
	var m = cls.class.findRespondingMethodFor(sel), ownerInst;
	if(m.isNil) { nil } {
		ownerInst = m.ownerClass.name.asString.drop(5).asSymbol.asClass;
		if(isUGenClass.(ownerInst).not) { nil } { m }
	}
};

probeMethod = { |cls, sel, m|
	var names = m.argNames.asArray.drop(1), defaults = m.prototypeFrame.asArray.drop(1).extend(names.size, nil);
	var probes = (), base, sentArgs, arrayLike = List.new, r, numOutArg, mainInputs, info;
	var hasNum = { |ugen, v| ugen.inputs.asArray.any { |x| x.isNumber and: { x == v } } };

	sentArgs = names.collect { |n, i| sentinelFor.(i) };

	r = probe.(cls, sel, []);
	probes[\defaults] = r[\res];

	base = probe.(cls, sel, sentArgs);
	probes[\sentinel] = base[\res];

	names.do { |n, i|
		var a = sentArgs.copy, rr;
		a[i] = [elemFor.(i, 0), elemFor.(i, 1), elemFor.(i, 2)];
		rr = probe.(cls, sel, a);
		probes[("array_" ++ n).asSymbol] = rr[\res];
		if(rr[\mains].size == 1 and: { hasNum.(rr[\mains][0], elemFor.(i, 1)) }) { arrayLike.add(i) };
	};

	names.do { |n, i|
		var a, rr;
		if(defaults[i].isNil) {
			a = sentArgs.copy;
			a[i] = nil;
			rr = probe.(cls, sel, a);
			probes[("nil_" ++ n).asSymbol] = rr[\res];
		};
	};

	if(arrayLike.size > 0) {
		[\finalA, \finalB].do { |key, which|
			var a = sentArgs.copy, rr;
			arrayLike.do { |i, k|
				var len = 3 + (2 * k) + which;
				a[i] = Array.fill(len, { |e| elemFor.(i, e) });
			};
			rr = probe.(cls, sel, a);
			probes[key] = rr[\res];
		};
	};

	// does any arg drive the output count?
	if(base[\mains].size == 1) {
		names.do { |n, i|
			if(numOutArg.isNil and: { safe.({ base[\mains][0].numOutputs }, -1) == sentinelFor.(i) }) { numOutArg = i };
		};
		if(numOutArg.notNil) {
			[3, 2].do { |nc|
				var a = sentArgs.copy, rr;
				a[numOutArg] = nc;
				rr = probe.(cls, sel, a);
				probes[("chan" ++ nc).asSymbol] = rr[\res];
			};
		};
	};

	// every input-like arg gets a DC UGen of the method's rate wrapping its sentinel
	// (bypasses scalar shortcuts such as Lag's `in.rate == \scalar` and satisfies rate checks)
	if(sel == \ar or: { sel == \kr }) {
		var ugenArgs = List.new, rr;
		names.do { |n, i|
			var inMain = base[\mains].size == 1 and: { hasNum.(base[\mains][0], sentinelFor.(i)) };
			if(i != numOutArg and: { n != \mul } and: { n != \add } and: {
				inMain or: { arrayLike.includes(i) } or: { base[\mains].size == 0 }
			}) { ugenArgs.add(i) };
		};
		rr = probe.(cls, sel, {
			var a = sentArgs.copy;
			ugenArgs.do { |i|
				a[i] = if(arrayLike.includes(i)) {
					[0, 1, 2].collect { |e| DC.perform(sel, elemFor.(i, e)) }
				} {
					DC.perform(sel, sentinelFor.(i))
				};
			};
			a
		});
		probes[\ugen] = rr[\res];
		probes[\ugen][\ugenArgs] = ugenArgs.collect { |i| names[i] };
	};

	info = (
		owner: m.ownerClass.name,
		file: m.filenameSymbol,
		charPos: m.charPos,
		argNames: names,
		defaults: defaults,
		varArgs: m.varArgs,
		arrayLike: arrayLike.collect { |i| names[i] },
		numOutArg: numOutArg !? { names[numOutArg] },
		probes: probes
	);
	info
};

classInfo = { |cls|
	var info = (), methods = ();
	var own = { |sel| var mm = cls.findRespondingMethodFor(sel); mm !? { [mm.ownerClass.name, mm.filenameSymbol, mm.charPos] } };
	var cown = { |sel| var mm = cls.class.findRespondingMethodFor(sel); mm !? { [mm.ownerClass.name, mm.filenameSymbol, mm.charPos] } };
	info[\class] = cls.name;
	info[\superclasses] = cls.superclasses.collect(_.name).select { |n|
		var c = n.asClass; c.notNil and: { isUGenClass.(c) }
	};
	info[\file] = cls.filenameSymbol;
	info[\internal] = internal.includes(cls.name);
	info[\isPure] = cls.superclasses.includes(PureUGen) or: { cls.superclasses.includes(PureMultiOutUGen) };
	info[\isMultiOut] = cls.superclasses.includes(MultiOutUGen);
	info[\isWidthFirst] = cls.superclasses.includes(WidthFirstUGen);
	info[\owners] = (
		optimizeGraph: own.(\optimizeGraph),
		checkInputs: own.(\checkInputs),
		init: own.(\init),
		initOutputs: own.(\initOutputs),
		numOutputs: own.(\numOutputs),
		signalRange: own.(\signalRange),
		writesToBus: own.(\writesToBus),
		writeDef: own.(\writeDef),
		name: own.(\name),
		new1: cown.(\new1),
		multiNewList: cown.(\multiNewList),
		numFixedArgs: cown.(\numFixedArgs),
		addToSynth: own.(\addToSynth),
		collectConstants: own.(\collectConstants),
		writeInputSpec: own.(\writeInputSpec)
	);
	if(cls.respondsTo(\numFixedArgs)) { info[\numFixedArgs] = safe.({ cls.numFixedArgs }, nil) };
	[\ar, \kr, \ir, \new].do { |sel|
		var r, m = methodInfo.(cls, sel);
		if(m.notNil) {
			if(info[\internal]) {
				methods[sel] = (
					owner: m.ownerClass.name,
					argNames: m.argNames.asArray.drop(1),
					defaults: m.prototypeFrame.asArray.drop(1),
					varArgs: m.varArgs
				);
			} {
				r = { Exception.inProtectedFunction = false; probeMethod.(cls, sel, m) }.try({ |e| (fatal: e.errorString) });
				methods[sel] = r;
			};
		};
	};
	info[\methods] = methods;
	info
};

classes = UGen.allSubclasses.select { |c| engineNames.includes(c.name) }.sort { |a, b| a.name < b.name };
if(onlyNames.notNil) { classes = classes.select { |c| onlyNames.includes(c.name) } };
("PROBING % classes".format(classes.size)).postln;

outFile = File(outPath, "w");
protect {
	classes.do { |cls|
		var line, info;
		("probing " ++ cls.name).postln;
		info = { Exception.inProtectedFunction = false; classInfo.(cls) }.try({ |e| (class: cls.name, fatal: "classInfo: " ++ e.class.name) });
		if(info.isKindOf(Dictionary).not) { info = (class: cls.name, fatal: "classInfo returned " ++ info.class.name) };
		line = { Exception.inProtectedFunction = false; json.(info) }.try({ |e| json.((class: cls.name, fatal: "json: " ++ e.class.name)) });
		if(line.isString.not) { line = json.((class: cls.name, fatal: "json returned " ++ line.class.name)) };
		outFile.write(line ++ "\n");
		outFile.flush;
	};
} {
	outFile.close;
	"PROBE DONE".postln;
	0.exit;
};
)
