import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Runtime } from '../src/runtime/runtime';
import { Sequencer } from '../src/seq/sequencer';
import type { PatchDoc } from '../src/runtime/patch';
import type { Engine } from '../src/engine/engine';
import { asEngine, FakeBank, FakeEngine, type Msg } from './fake-engine';

vi.useFakeTimers();

const LFO = "SinOsc.kr(param('rate', 0.2, 'lofreq'))";
const OSC = "Saw.ar(param('freq', 110, 'freq')) * 0.2";
const OSC2 = "Pulse.ar(param('freq', 110, 'freq'), 0.3) * 0.2";
const FILTER = "RLPF.ar(input('osc'), param('cutoff', 900, 'freq'), param('rq', 0.3, [0.05, 1]))";
const SUB = "SinOsc.ar(param('freq', 55, 'freq')) * 0.3";
const LOOPER = "QLoop.ar(sample('break'), { rate: param('rate', 1, [0, 2, 'lin', 0.25]) })";

// The host builds the patch; a listener's runtime follows the host's document.
let host: Runtime;
let eng: FakeEngine;
let bank: FakeBank;
let rt: Runtime;

const hostDoc = () => structuredClone(host.doc);
/** What the runtime owns (routines and the tempo are the sequencer's). */
const comparable = (d: PatchDoc) => {
  const { routines: _r, bpm: _b, ...rest } = structuredClone(d);
  return rest;
};
const created = (sent: Msg[]) => sent.filter((m) => m[0] === '/s_new');
const released = (sent: Msg[], node: number | null) => sent.some((m) => m[0] === '/n_set' && m[1] === node && m.includes('__gate') && m[m.indexOf('__gate') + 1] === 0);

beforeEach(async () => {
  host = new Runtime(asEngine(new FakeEngine()), new FakeBank());
  eng = new FakeEngine();
  bank = new FakeBank();
  rt = new Runtime(asEngine(eng), bank);
  await host.defineModule('lfo', { kind: 'control', code: LFO });
  await host.defineModule('osc', { kind: 'audio', code: OSC, play: false });
  await host.defineModule('filter', { kind: 'audio', code: FILTER });
  host.modulate('lfo', 'filter.cutoff', 0.3);
  host.defineMacro('dark', { value: 0.2, targets: [{ target: 'filter.rq', amount: 0.2 }] });
  await rt.loadPatch(hostDoc());
  eng.take();
});

describe('following a document in place', () => {
  it('moves a knob, and nothing restarts', async () => {
    host.setParam('osc', 'freq', 220);
    const node = rt.module('osc')!.node;
    expect(await rt.reconcile(hostDoc())).toEqual([]);
    const sent = eng.take();
    expect(created(sent)).toEqual([]);
    expect(sent).toContainEqual(['/n_set', node, 'freq', 220]);
    expect(comparable(rt.doc)).toEqual(comparable(host.doc));
  });

  it("puts back a knob the listener moved: following means the host's patch", async () => {
    rt.setParam('osc', 'freq', 300);
    await rt.reconcile(hostDoc());
    expect(rt.paramValue('osc', 'freq')).toBe(110);
    expect(rt.doc.modules.osc.params).toEqual({});
  });

  it('moves a modulated knob through its modulation sum', async () => {
    host.setParam('filter', 'cutoff', 2000);
    await rt.reconcile(hostDoc());
    const sent = eng.take();
    expect(created(sent)).toEqual([]);
    expect(sent.some((m) => m[0] === '/n_set' && m[2] === 'pos')).toBe(true);
    expect(rt.paramValue('filter', 'cutoff')).toBe(2000);
  });

  it('crossfades new code in, and leaves the other modules running', async () => {
    const before = { osc: rt.module('osc')!.node, filter: rt.module('filter')!.node, lfo: rt.module('lfo')!.node };
    await host.defineModule('osc', { kind: 'audio', code: OSC2 });
    expect(await rt.reconcile(hostDoc())).toEqual([]);
    const sent = eng.take();
    const news = created(sent);
    expect(news).toHaveLength(1);
    expect(news[0].slice(2, 5)).toEqual([rt.module('osc')!.node, 3, before.osc]);
    expect(released(sent, before.osc)).toBe(true);
    expect(rt.module('filter')!.node).toBe(before.filter);
    expect(rt.module('lfo')!.node).toBe(before.lfo);
    expect(rt.doc.modules.osc.code).toBe(OSC2);
  });

  it('adds what is new and fades out what is gone, routes with it', async () => {
    const lfo = rt.module('lfo')!.node;
    await host.removeModule('lfo', { force: true });
    await host.defineModule('sub', { kind: 'audio', code: SUB, level: 0.5 });
    expect(await rt.reconcile(hostDoc())).toEqual([]);
    const sent = eng.take();
    expect(released(sent, lfo)).toBe(true);
    expect(rt.module('lfo')).toBeUndefined();
    expect(rt.module('sub')?.node).not.toBeNull();
    expect(rt.doc.mods.some((r) => r.source === 'lfo')).toBe(false);
    expect(comparable(rt.doc)).toEqual(comparable(host.doc));
  });

  it('follows routes and macros: amounts, values, new ones and gone ones', async () => {
    host.modulate('lfo', 'filter.cutoff', 0.6);
    host.setMacro('dark', 0.9);
    host.defineMacro('bright', { value: 0.5, bipolar: true, targets: [{ target: 'osc.freq', amount: 0.1 }] });
    await rt.reconcile(hostDoc());
    expect(comparable(rt.doc)).toEqual(comparable(host.doc));
    const sent = eng.take();
    expect(sent.some((m) => m[0] === '/c_set' && m[2] === 0.9)).toBe(true);
    expect(sent.some((m) => m[0] === '/c_set' && m[2] === 0)).toBe(true); // bright, bipolar at the centre

    host.removeMacro('bright');
    host.modulate('lfo', 'filter.cutoff', 0);
    await rt.reconcile(hostDoc());
    expect(rt.doc.macros.bright).toBeUndefined();
    expect(rt.doc.mods).toEqual(host.doc.mods);
  });

  it('follows the mixer: fader, pan, mute and solo', async () => {
    await host.defineModule('sub', { kind: 'audio', code: SUB });
    await rt.reconcile(hostDoc());
    host.setMonitor('filter', { level: 0.5, pan: -0.25 });
    host.setMonitor('sub', { solo: true });
    eng.take();
    await rt.reconcile(hostDoc());
    const sent = eng.take();
    const monitor = rt.module('filter')!.monitor;
    const last = sent.filter((m) => m[1] === monitor).at(-1)!;
    expect(last[last.indexOf('level') + 1]).toBe(0.5);
    expect(last[last.indexOf('pan') + 1]).toBe(-0.25);
    expect(last[last.indexOf('mute') + 1]).toBe(1); // sub is soloed
    expect(rt.silenced('filter')).toBe(true);
    expect(comparable(rt.doc)).toEqual(comparable(host.doc));
  });

  it('brings subpatches and samples along, and the buffers before the modules', async () => {
    await host.defineSample('break', { src: 'stock:loop_amen', beats: 4 });
    await host.defineModule('drums/loop', { kind: 'audio', code: LOOPER });
    await host.defineSubpatch('drums', { controls: { rate: 'loop.rate' } });
    expect(await rt.reconcile(hostDoc())).toEqual([]);
    expect(bank.get('stock:loop_amen')).toBeDefined();
    expect(rt.module('drums/loop')!.wiring.__smp_0).toBe(bank.get('stock:loop_amen')!.bufnum);
    expect(comparable(rt.doc)).toEqual(comparable(host.doc));
  });

  it('from nothing, builds the same patch loadPatch does', async () => {
    host.setSurface([{ ref: 'macro:dark' }, { ref: 'filter.cutoff', label: 'Cutoff' }]);
    host.setMasterLevel(0.6);
    const fresh = new Runtime(asEngine(new FakeEngine()), new FakeBank());
    expect(await fresh.reconcile(hostDoc())).toEqual([]);
    expect(comparable(fresh.doc)).toEqual(comparable(host.doc));
  });

  it("says what it couldn't build and builds the rest", async () => {
    const doc = hostDoc();
    doc.modules.broken = { ...doc.modules.osc, code: "SinOsc.ar(input('nowhere'))" };
    doc.modules.sub = { ...doc.modules.osc, code: SUB };
    const errors = await rt.reconcile(doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^broken: /);
    expect(rt.module('broken')).toBeUndefined();
    expect(rt.doc.modules.broken).toBeUndefined();
    expect(rt.module('sub')).toBeDefined();
  });
});

describe('the sequencer follows routines in place', () => {
  const engine = () => Object.assign(new FakeEngine(), { sonic: { clock: null } }) as unknown as Engine;

  it('defines new and rewritten routines, starts and stops the rest, and drops the gone', () => {
    const seq = new Sequencer(rt, engine());
    seq.load({
      a: { code: 'while (true) { yield 1; }', playing: true, quant: 4 },
      b: { code: 'while (true) { yield 2; }', playing: true, quant: 4 },
    });
    const errors = seq.follow({
      a: { code: 'while (true) { yield 1; }', playing: false, quant: 4 },
      c: { code: 'while (true) { yield 0.5; }', playing: true, quant: 1, description: 'hats' },
    });
    expect(errors).toEqual([]);
    expect(seq.list().map((r) => [r.name, r.playing])).toEqual([
      ['a', false],
      ['c', true],
    ]);
    expect(rt.doc.routines.c).toMatchObject({ playing: true, quant: 1, description: 'hats' });
    expect(rt.doc.routines.b).toBeUndefined();

    expect(seq.follow({ a: { code: 'while (true) { yield 3; }', playing: true, quant: 4 }, c: rt.doc.routines.c })).toEqual([]);
    expect(rt.doc.routines.a).toMatchObject({ code: 'while (true) { yield 3; }', playing: true });
    expect(seq.follow({ a: rt.doc.routines.a, c: rt.doc.routines.c, d: { code: 'yield (', playing: true, quant: 4 } })[0]).toMatch(/^routine d: /);
  });
});
