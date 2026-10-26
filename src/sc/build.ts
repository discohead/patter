// Build a whole SynthDef from patch-language code with sclang-style arguments:
// buildSynthDef('sine', { out: 0, freq: 440 }, 'Out.ar(out, SinOsc.ar(freq))')
// is SynthDef(\sine, { |out=0, freq=440| Out.ar(out, SinOsc.ar(freq)) }).

import { compileBody } from './dsl';
import { baseScope } from './scope';
import { finishSynthDef, type BuiltSynthDef } from './synthdef';
import { GraphBuilder, withBuilder } from './ugen';

export function buildSynthDef(name: string, args: Record<string, number | number[]>, code: string): BuiltSynthDef {
  const g = new GraphBuilder();
  const scope: Record<string, unknown> = { ...baseScope(), $guard: () => {}, $at: () => {} };
  for (const [arg, dflt] of Object.entries(args)) {
    const rate = arg.startsWith('t_') ? 'trigger' : arg.startsWith('i_') ? 'scalar' : arg.startsWith('a_') ? 'audio' : 'control';
    scope[arg] = withBuilder(g, () => {
      const sigs = g.control(arg, rate, Array.isArray(dflt) ? dflt : [dflt]);
      return sigs.length === 1 ? sigs[0] : sigs;
    });
  }
  const fn = compileBody(code, Object.keys(scope), { operators: true, loopGuard: true, autoReturn: false });
  withBuilder(g, () => fn.run(scope));
  return finishSynthDef(name, g);
}
