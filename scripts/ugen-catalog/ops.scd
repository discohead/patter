// ops.scd — operator selector -> specialIndex for UnaryOpUGen / BinaryOpUGen, as sclang computes it.
// Candidate selectors = every composeUnaryOp / composeBinaryOp selector in AbstractFunction.sc (plus == and !=).
//   HOME=<scratch>/schome sclang ops.scd <out.json>
(
var unary = [\abs,\acos,\ampdb,\asFloat,\asin,\asInteger,\asRef,\atan,\bilinrand,\binaryValue,\bitNot,\ceil,\coin,\cos,\cosh,\cpsmidi,\cpsoct,\cubed,\dbamp,\degrad,\distort,\even,\exp,\floor,\frac,\hanWindow,\isNegative,\isPositive,\isStrictlyPositive,\linrand,\log,\log10,\log2,\midicps,\midiratio,\neg,\not,\octcps,\odd,\raddeg,\ramp,\rand,\rand2,\ratiomidi,\reciprocal,\rectWindow,\rho,\scurve,\sign,\sin,\sinh,\softclip,\sqrt,\squared,\sum3rand,\tan,\tanh,\theta,\triWindow,\welWindow];
var binary = ['-','@','*','/','&&','+','<','<=','>','>=','|==|','||','absdif','amclip','atan2','bitAnd','bitOr','bitXor','clip2','difsqr','dist','div','excess','exprand','firstArg','fold2','gcd','hammingDistance','hypot','hypotApx','lcm','leftShift','max','min','mod','modSeaside','nand','pow','rightShift','ring1','ring2','ring3','ring4','rotate','round','roundUp','rrand','scaleneg','sqrdif','sqrsum','sumsqr','thresh','trunc','unsignedRightShift','wrap2','xor', '==', '!='];
var f = File(thisProcess.argv[0], "w");
var enc = { |list| "{" ++ list.select { |s| s.specialIndex >= 0 }.collect { |s| "\"" ++ s.asString ++ "\":" ++ s.specialIndex }.join(",") ++ "}" };
f.write("{\"unary\":" ++ enc.(unary) ++ ",\"binary\":" ++ enc.(binary) ++ ",\"unsupportedUnary\":[" ++ unary.select { |s| s.specialIndex < 0 }.collect { |s| "\"" ++ s ++ "\"" }.join(",") ++ "],\"unsupportedBinary\":[" ++ binary.select { |s| s.specialIndex < 0 }.collect { |s| "\"" ++ s ++ "\"" }.join(",") ++ "]}");
f.close;
"OPS DONE".postln;
0.exit;
)
