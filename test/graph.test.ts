import { describe, expect, it } from 'vitest';
import { buildSynthDef } from '../src/sc/build';
import { netlist } from '../src/runtime/graph';

describe('netlist', () => {
  it('labels inputs by argument name and shows operators', () => {
    const def = buildSynthDef('t', { out: 0, freq: 110, cutoff: 1200 }, `
      const env = EnvGen.kr(Env.perc(0.01, 0.5), Impulse.kr(2));
      Out.ar(out, RLPF.ar(Saw.ar(freq * [1, 1.01]), cutoff * (1 + env), 0.3) * 0.2)
    `).data;
    const text = netlist(def);
    console.log(text);
    expect(text).toContain('RLPF.ar(in: ');
    expect(text).toContain('Saw.ar(freq: ');
    expect(text).toMatch(/\*\(/);
  });
});
