import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Runtime } from '../src/runtime/runtime';
import { resolveParam, resolveSource } from '../src/runtime/resolve';
import { asEngine, FakeEngine } from './fake-engine';

vi.useFakeTimers();

const LFO = "SinOsc.kr(param('rate', 0.2, 'lofreq'))";
const OSC = "Saw.ar(param('freq', 110, 'freq')) * 0.2";
const FILTER = "RLPF.ar(input('osc'), param('cutoff', 900, 'freq') * (1 + input('lfo') * 0.2), 0.3)";
const VCA = "input('filter') * param('level', 0.8, 'amp')";

let eng: FakeEngine;
let rt: Runtime;

async function basic() {
  await rt.defineModule('lfo', { kind: 'control', code: LFO });
  await rt.defineModule('osc', { kind: 'audio', code: OSC, play: false });
  await rt.defineModule('filter', { kind: 'audio', code: FILTER, play: false });
  await rt.defineModule('vca', { kind: 'audio', code: VCA });
}

const busOf = (p: string) => rt.module(p)!.bus;
/** ref as written → the bus it's wired to. */
const wiringOf = (p: string): Record<string, number> => {
  const m = rt.module(p)!;
  return Object.fromEntries(m.compiled.refs.map((r) => [r.ref, m.wiring[r.control]]));
};

beforeEach(() => {
  eng = new FakeEngine();
  rt = new Runtime(asEngine(eng));
});

describe('hierarchy: paths and scoping', () => {
  it('builds modules inside a subpatch by path, resolving siblings lexically', async () => {
    await rt.defineModule('lfo', { kind: 'control', code: LFO });
    await rt.defineSubpatch('voice', { inlets: { lfo: { from: 'lfo' } } });
    await rt.defineModule('voice/osc', { kind: 'audio', code: OSC, play: false });
    await rt.defineModule('voice/filter', { kind: 'audio', code: FILTER, play: false });
    expect(wiringOf('voice/filter')).toEqual({ osc: busOf('voice/osc'), lfo: busOf('lfo') });
    expect(resolveSource(rt.doc, 'voice', 'lfo')).toEqual({ kind: 'module', module: 'lfo', output: undefined });
  });

  it('reports what is visible when a name does not resolve', async () => {
    await rt.defineModule('voice/osc', { kind: 'audio', code: OSC });
    await expect(rt.defineModule('voice/filter', { kind: 'audio', code: "LPF.ar(input('oscc'), 500)" })).rejects.toThrow(/no 'oscc' in subpatch 'voice' \(there: osc\)/);
  });

  it('reading an outside name in a plain subpatch adds the inlet', async () => {
    await rt.defineModule('lfo', { kind: 'control', code: LFO });
    await rt.defineModule('a/b/osc', { kind: 'audio', code: "SinOsc.ar(300 * (1 + input('lfo') * 0.1)) * 0.1" });
    expect(rt.doc.subpatches.a.inlets.lfo).toMatchObject({ from: 'lfo', rate: 'control', channels: 1 });
    expect(rt.doc.subpatches['a/b'].inlets.lfo).toMatchObject({ from: 'lfo' });
    expect(wiringOf('a/b/osc')).toEqual({ lfo: busOf('lfo') });
  });

  it('a new sibling shadows what a ref resolved to before', async () => {
    await rt.defineModule('osc', { kind: 'audio', code: OSC, play: false });
    await rt.defineModule('voice/filter', { kind: 'audio', code: "LPF.ar(input('osc'), 800)" });
    expect(wiringOf('voice/filter')).toEqual({ osc: busOf('osc') }); // via an auto-inlet
    await rt.defineModule('voice/osc', { kind: 'audio', code: "Pulse.ar(80) * 0.1", play: false });
    expect(wiringOf('voice/filter')).toEqual({ osc: busOf('voice/osc') });
  });

  it('play follows across instances; level stays per instance', async () => {
    await basic();
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    await rt.saveAbstraction('voice', 'synth');
    await rt.instantiate('synth', 'voice2', { inlets: { lfo: 'lfo' } });
    rt.setMonitor('voice/filter', { play: true, level: 0.5 });
    expect(rt.doc.modules['voice2/filter'].play).toBe(true);
    expect(rt.doc.modules['voice2/filter'].level).toBe(1);
  });

  it('refuses param names scsynth would refuse (over 31 characters)', async () => {
    await expect(rt.defineModule('long', { kind: 'control', code: "param('a_really_long_parameter_name_here', 0.5)" })).rejects.toThrow(/at most 31 characters/);
  });

  it('an unconnected inlet is silence, not an error', async () => {
    await rt.defineSubpatch('fx', { inlets: { in: { from: null, rate: 'audio', channels: 2 } } });
    const r = await rt.defineModule('fx/verb', { kind: 'audio', code: "FreeVerb.ar(input('in'), 0.4, 0.8)" });
    expect(r.inputs[0].from).toMatch(/unconnected/);
  });
});

describe('group into a subpatch (encapsulate)', () => {
  it('moves members without restarting them, makes inlets from outside sources and an outlet for outside readers', async () => {
    await basic();
    const oscNode = rt.module('osc')!.node;
    const filterNode = rt.module('filter')!.node;
    const vcaNode = rt.module('vca')!.node;
    eng.take();
    const res = await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    expect(res.inlets).toEqual({ lfo: 'lfo' });
    expect(res.outlets).toEqual({ out: 'filter' });
    expect(rt.module('voice/osc')!.node).toBe(oscNode); // same node: not restarted
    expect(rt.module('voice/filter')!.node).toBe(filterNode);
    // the outside reader was rewritten to read the subpatch's main outlet
    expect(rt.doc.modules.vca.code).toContain("input('voice')");
    expect(res.rewritten).toEqual(['vca']);
    expect(rt.module('vca')!.node).toBe(vcaNode); // a renamed ref compiles to the same SynthDef
    expect(wiringOf('vca')).toEqual({ voice: busOf('voice/filter') });
    expect(wiringOf('voice/filter')).toEqual({ osc: busOf('voice/osc'), lfo: busOf('lfo') });
    // the moved modules' code is untouched: lexical scoping did the work
    expect(rt.doc.modules['voice/filter'].code).toBe(FILTER);
  });

  it('keeps routes and the surface pointing at moved modules', async () => {
    await basic();
    rt.modulate('lfo', 'filter.cutoff', 0.3);
    rt.setSurface([{ ref: 'filter.cutoff', label: 'Cutoff' }]);
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    expect(rt.doc.mods).toEqual([{ source: 'lfo', target: 'voice/filter.cutoff', amount: 0.3 }]);
    expect(rt.doc.surface[0].ref).toBe('voice/filter.cutoff');
  });

  it('ungroup is the inverse', async () => {
    await basic();
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    const res = await rt.ungroup('voice');
    expect(res.moved.sort()).toEqual(['filter', 'osc']);
    expect(rt.doc.subpatches.voice).toBeUndefined();
    expect(rt.doc.modules.vca.code).toBe(VCA);
    expect(wiringOf('vca')).toEqual({ filter: busOf('filter') });
  });
});

describe('subpatch controls', () => {
  it('exposes inner params on the subpatch face; routes resolve through them', async () => {
    await basic();
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    await rt.defineSubpatch('voice', { controls: { cutoff: 'filter.cutoff', pitch: 'osc.freq' } });
    expect(resolveParam(rt.doc, '', 'voice.cutoff')).toEqual({ kind: 'param', module: 'voice/filter', param: 'cutoff' });
    rt.setByRef('voice.cutoff', 1500);
    expect(rt.doc.modules['voice/filter'].params.cutoff).toBe(1500);
    rt.modulate('lfo', 'voice.pitch', 0.1);
    expect(rt.doc.mods[0].target).toBe('voice/osc.freq');
  });
});

describe('abstractions', () => {
  it('instances share compiled SynthDefs and stay in sync when edited', async () => {
    await basic();
    await rt.defineModule('lfo2', { kind: 'control', code: LFO });
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    await rt.saveAbstraction('voice', 'synth', 'saw → resonant lowpass');
    const inst = await rt.instantiate('synth', 'voice2', { inlets: { lfo: 'lfo2' }, params: { 'osc.freq': 220 } });
    expect(inst.warnings).toEqual([]);
    expect(rt.module('voice2/osc')!.defName).toBe(rt.module('voice/osc')!.defName);
    expect(rt.module('voice2/filter')!.defName).toBe(rt.module('voice/filter')!.defName);
    expect(rt.doc.modules['voice2/osc'].params.freq).toBe(220);
    expect(wiringOf('voice2/filter').lfo).toBe(busOf('lfo2'));

    // Edit one instance: the abstraction and the other instance follow.
    const NEW = "MoogFF.ar(input('osc'), param('cutoff', 900, 'freq') * (1 + input('lfo') * 0.2), 2)";
    const r = await rt.defineModule('voice2/filter', { kind: 'audio', code: NEW });
    expect(r.abstraction).toEqual({ name: 'synth', instancesUpdated: ['voice'] });
    expect(rt.doc.modules['voice/filter'].code).toBe(NEW);
    expect(rt.doc.abstractions.synth.modules.filter.code).toBe(NEW);
    expect(rt.module('voice/filter')!.defName).toBe(rt.module('voice2/filter')!.defName);
    // each instance keeps its own knob values
    expect(rt.doc.modules['voice2/osc'].params.freq).toBe(220);
    expect(rt.doc.modules['voice/osc'].params.freq).toBeUndefined();
  });

  it('detach stops propagation', async () => {
    await basic();
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    await rt.saveAbstraction('voice', 'synth');
    await rt.instantiate('synth', 'voice2', { inlets: { lfo: 'lfo' } });
    await rt.detach('voice2');
    await rt.defineModule('voice2/osc', { kind: 'audio', code: "Pulse.ar(param('freq', 110, 'freq')) * 0.2" });
    expect(rt.doc.modules['voice/osc'].code).toBe(OSC);
  });

  it('a whole hierarchical patch survives save and load', async () => {
    await basic();
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    await rt.saveAbstraction('voice', 'synth');
    await rt.instantiate('synth', 'voice2', { inlets: { lfo: 'lfo' } });
    rt.modulate('lfo', 'voice2/filter.cutoff', 0.25);
    const saved = JSON.parse(JSON.stringify(rt.doc));
    const rt2 = new Runtime(asEngine(new FakeEngine()));
    const errors = await rt2.loadPatch(saved);
    expect(errors).toEqual([]);
    expect(Object.keys(rt2.doc.modules).sort()).toEqual(['lfo', 'vca', 'voice/filter', 'voice/osc', 'voice2/filter', 'voice2/osc']);
    expect(rt2.doc.mods).toEqual([{ source: 'lfo', target: 'voice2/filter.cutoff', amount: 0.25 }]);
    const m2 = rt2.module('voice2/filter')!;
    expect(m2.wiring[m2.compiled.refs.find((r) => r.ref === 'lfo')!.control]).toBe(rt2.module('lfo')!.bus);
  });

  it('routes and macros inside an instance reach every instance', async () => {
    await basic();
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    await rt.saveAbstraction('voice', 'synth');
    await rt.instantiate('synth', 'voice2', { inlets: { lfo: 'lfo' } });
    await rt.defineModule('voice/wobble', { kind: 'control', code: "LFTri.kr(param('rate', 3, 'lofreq'))" });
    expect(rt.module('voice2/wobble')).toBeDefined();
    rt.modulate('voice/wobble', 'voice/filter.cutoff', 0.2);
    expect(rt.doc.mods).toContainEqual({ source: 'voice2/wobble', target: 'voice2/filter.cutoff', amount: 0.2 });
    expect(rt.doc.abstractions.synth.mods).toEqual([{ source: 'wobble', target: 'filter.cutoff', amount: 0.2 }]);
    // a route from outside into one instance is that instance's own
    rt.modulate('lfo', 'voice2/osc.freq', 0.05);
    expect(rt.doc.mods.some((r) => r.target === 'voice/osc.freq')).toBe(false);
    rt.defineMacro('voice/bright', { targets: [{ target: 'voice/filter.cutoff', amount: 0.5 }] });
    expect(rt.doc.macros['voice2/bright']).toBeDefined();
    expect(rt.doc.mods).toContainEqual({ source: 'macro:voice2/bright', target: 'voice2/filter.cutoff', amount: 0.5 });
    rt.setMacro('voice2/bright', 0.9);
    expect(rt.doc.macros['voice/bright'].value).toBe(0); // values stay per instance
    rt.removeMacro('voice/bright');
    expect(rt.doc.macros['voice2/bright']).toBeUndefined();
  });

  it('structural edits inside one instance rebuild the others to match, keeping their knobs', async () => {
    await basic();
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    await rt.saveAbstraction('voice', 'synth');
    await rt.instantiate('synth', 'voice2', { inlets: { lfo: 'lfo' }, params: { 'osc.freq': 330 } });
    await rt.groupIntoSubpatch('voice', 'src', ['osc']);
    expect(Object.keys(rt.doc.abstractions.synth.modules).sort()).toEqual(['filter', 'src/osc']);
    expect(rt.doc.modules['voice2/src/osc']).toBeDefined();
    expect(rt.doc.modules['voice2/osc']).toBeUndefined();
    expect(rt.doc.modules['voice2/src/osc'].params.freq).toBe(330);
    expect(rt.doc.modules['voice2/filter'].code).toContain("input('src')");
    expect(wiringOf('voice2/filter').src).toBe(busOf('voice2/src/osc'));
  });

  it('the replayed edit keeps the other instance running', async () => {
    await basic();
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    await rt.saveAbstraction('voice', 'synth');
    await rt.instantiate('synth', 'voice2', { inlets: { lfo: 'lfo' } });
    const nodes = [rt.module('voice2/osc')!.node, rt.module('voice2/filter')!.node];
    await rt.groupIntoSubpatch('voice', 'src', ['osc']);
    await rt.ungroup('voice/src');
    expect([rt.module('voice2/osc')!.node, rt.module('voice2/filter')!.node]).toEqual(nodes);
    expect(rt.doc.modules['voice2/filter'].code).toBe(FILTER);
  });

  it('nested instances are kept by reference', async () => {
    await rt.defineModule('lfo', { kind: 'control', code: LFO });
    await rt.defineModule('env/adsr', { kind: 'control', code: "EnvGen.kr(Env.adsr(param('attack', 0.01, 'time')), param('gate', 1))" });
    await rt.saveAbstraction('env', 'adsr');
    await rt.defineModule('voice/osc', { kind: 'audio', code: OSC, play: false });
    await rt.instantiate('adsr', 'voice/env');
    await rt.defineModule('voice/vca', { kind: 'audio', code: "input('osc') * input('env')" });
    await rt.saveAbstraction('voice', 'synth');
    expect(Object.keys(rt.doc.abstractions.synth.modules).sort()).toEqual(['osc', 'vca']);
    expect(rt.doc.abstractions.synth.subpatches.env.abstraction).toBe('adsr');
    rt.setParam('voice/env/adsr', 'attack', 0.3);
    await rt.instantiate('synth', 'voice2');
    expect(rt.doc.modules['voice2/env/adsr']).toBeDefined();
    expect(rt.doc.subpatches['voice2/env'].abstraction).toBe('adsr');
    // editing the inner abstraction anywhere reaches the copies inside every outer instance
    await rt.defineModule('env/adsr', { kind: 'control', code: "EnvGen.kr(Env.adsr(param('attack', 0.01, 'time'), 0.5), param('gate', 1))" });
    expect(rt.doc.modules['voice2/env/adsr'].code).toContain('0.5)');
    expect(rt.doc.modules['voice/env/adsr'].code).toContain('0.5)');
    expect(rt.doc.modules['voice/env/adsr'].params.attack).toBe(0.3);
  });

  it('duplicate copies a module, a plain subpatch, or makes another linked instance', async () => {
    await basic();
    const r1 = await rt.duplicate('osc');
    expect(r1.path).toBe('osc_2');
    expect(rt.doc.modules.osc_2.code).toBe(OSC);
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    const r2 = await rt.duplicate('voice');
    expect(r2.path).toBe('voice_2');
    expect(rt.doc.subpatches.voice_2.abstraction).toBeUndefined();
    expect(rt.doc.subpatches.voice_2.inlets.lfo.from).toBe('lfo');
    await rt.saveAbstraction('voice', 'synth');
    const r3 = await rt.duplicate('voice');
    expect(rt.doc.subpatches[r3.path].abstraction).toBe('synth');
    expect(rt.instancesOf('synth').sort()).toEqual(['voice', r3.path].sort());
  });

  it('moduleFor resolves subpatches to their main outlet', async () => {
    await basic();
    await rt.groupIntoSubpatch('', 'voice', ['osc', 'filter']);
    expect(rt.moduleFor('voice')).toBe('voice/filter');
    expect(rt.moduleFor('voice/osc')).toBe('voice/osc');
  });
});
