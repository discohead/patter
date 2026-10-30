import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Runtime } from '../src/runtime/runtime';
import { compileModule } from '../src/runtime/module-def';
import { asEngine, FakeBank, FakeEngine } from './fake-engine';

vi.useFakeTimers();

let eng: FakeEngine;
let bank: FakeBank;
let rt: Runtime;

beforeEach(() => {
  eng = new FakeEngine();
  bank = new FakeBank();
  bank.shapes['stock:loop_amen'] = { channels: 1, frames: 85000 };
  bank.shapes['stock:loop_compus'] = { channels: 1, frames: 300000 };
  bank.shapes['stock:loop_garzul'] = { channels: 2, frames: 400000 };
  rt = new Runtime(asEngine(eng), bank);
});

const LOOPER = "QLoop.ar(sample('break'), { rate: param('rate', 1, [0, 2, 'lin', 0.25]) })";

describe('samples', () => {
  it('a module plays a patch sample: buffer, beats and root arrive as controls', async () => {
    const added = await rt.defineSample('break', { src: 'stock:loop_amen', beats: 4 });
    expect(added.sample).toMatchObject({ channels: 1, frames: 85000, beats: 4 });
    const r = await rt.defineModule('loop', { kind: 'audio', code: LOOPER });
    expect(r.samples).toEqual([{ ref: 'break', sample: 'break' }]);
    const m = rt.module('loop')!;
    expect(m.wiring.__smp_0).toBe(bank.get('stock:loop_amen')!.bufnum);
    expect(m.wiring.__sbt_0).toBe(4);
    expect(m.compiled.playhead).toBe(true);
    expect(rt.sampleUsers('break')).toEqual(['loop']);
  });

  it('new audio under the same name reaches the running node without a restart', async () => {
    await rt.defineSample('break', { src: 'stock:loop_amen', beats: 4 });
    await rt.defineModule('loop', { kind: 'audio', code: LOOPER });
    const node = rt.module('loop')!.node;
    eng.take();
    await rt.defineSample('break', { src: 'stock:loop_compus', beats: 16 });
    expect(rt.module('loop')!.node).toBe(node);
    const set = eng.take().find((m) => m[0] === '/n_set' && m[1] === node);
    expect(set).toEqual(['/n_set', node, '__smp_0', bank.get('stock:loop_compus')!.bufnum, '__sbt_0', 16]);
    expect(bank.kept).toEqual(new Set(['stock:loop_compus']));
  });

  it('a different channel count recompiles (with a crossfade)', async () => {
    await rt.defineSample('break', { src: 'stock:loop_amen', beats: 4 });
    await rt.defineModule('loop', { kind: 'audio', code: LOOPER });
    const node = rt.module('loop')!.node;
    const r = await rt.defineSample('break', { src: 'stock:loop_garzul', beats: 8 });
    expect(r.warnings.join()).toMatch(/recompiled/);
    expect(rt.module('loop')!.node).not.toBe(node);
    expect(rt.module('loop')!.compiled.samples[0].channels).toBe(2);
  });

  it('a subpatch slot lets each abstraction instance play its own sample', async () => {
    await rt.defineSample('amen', { src: 'stock:loop_amen', beats: 4 });
    await rt.defineSample('compus', { src: 'stock:loop_compus', beats: 16 });
    await rt.defineSubpatch('a', { samples: { hit: 'amen' } });
    await rt.defineModule('a/play', { kind: 'audio', code: "OneShot.ar(sample('hit'), { trig: Impulse.kr(1) })" });
    await rt.saveAbstraction('a', 'player');
    await rt.instantiate('player', 'b', { samples: { hit: 'compus' } });
    const [a, b] = [rt.module('a/play')!, rt.module('b/play')!];
    expect(a.defName).toBe(b.defName);
    expect(a.wiring.__smp_0).toBe(bank.get('stock:loop_amen')!.bufnum);
    expect(b.wiring.__smp_0).toBe(bank.get('stock:loop_compus')!.bufnum);
    expect(rt.sampleUsers('compus')).toEqual(['b/play']);
  });

  it('refuses to remove a sample something plays; a saved patch brings its samples back', async () => {
    await rt.defineSample('break', { src: 'stock:loop_amen', beats: 4 });
    await rt.defineModule('loop', { kind: 'audio', code: LOOPER });
    await expect(rt.removeSample('break')).rejects.toThrow(/played by loop/);
    const saved = JSON.parse(JSON.stringify(rt.doc));
    const bank2 = new FakeBank();
    bank2.shapes['stock:loop_amen'] = { channels: 1, frames: 85000 };
    const rt2 = new Runtime(asEngine(new FakeEngine()), bank2);
    expect(await rt2.loadPatch(saved)).toEqual([]);
    expect(rt2.module('loop')!.wiring.__smp_0).toBe(bank2.get('stock:loop_amen')!.bufnum);
  });

  it('names what is missing', async () => {
    await expect(rt.defineModule('loop', { kind: 'audio', code: LOOPER })).rejects.toThrow(/no sample 'break' \(the patch has no samples yet/);
  });
});

describe('the samplers compile', () => {
  const shape = { channels: 2, frames: 96000, duration: 2, beats: 4, root: 60 };
  const compile = (kind: 'audio' | 'voice', code: string) => compileModule({ name: 't', kind, code, resolve: () => { throw new Error('no inputs'); }, resolveSample: () => shape });

  it('QLoop in tape and stretch modes, with a microtonal scale', () => {
    const tape = compile('audio', "QLoop.ar(sample('s'), { start: param('start', 0), length: param('length', 2), rate: param('rate', 1), reverse: param('rev', 0), quant: 4 })");
    expect(tape.shape.channels).toBe(2);
    expect(tape.data.ugens.filter((u) => u.name === 'BufRd')).toHaveLength(2);
    expect(tape.data.ugens.some((u) => u.name === 'LinkPhase')).toBe(true);
    const stretch = compile('audio', "QLoop.ar(sample('s'), { pitch: param('pitch', 0), scale: [0, 2.04, 3.86, 4.98, 7.02, 8.84, 10.88], mode: 'stretch', retrigger: true })");
    expect(stretch.data.ugens.some((u) => u.name === 'Warp1')).toBe(true);
    expect(stretch.warnings).toEqual([]);
    expect(compile('audio', "QLoop.ar(sample('s'), { pitch: 3 })").warnings.join()).toMatch(/pitch needs mode: 'stretch'/);
  });

  it('OneShot ends a voice by itself, and only a voice', () => {
    const doneAction = (c: ReturnType<typeof compile>) => {
      const play = c.data.ugens.find((u) => u.name === 'PlayBuf')!;
      const [ugen, index] = play.inputs[play.inputs.length - 1] as unknown as [number, number];
      return ugen === -1 ? c.data.constants[index] : NaN;
    };
    const voice = compile('voice', "OneShot.ar(sample('s'), { note: param('note', 60), amp: param('amp', 0.5) })");
    expect(voice.warnings).toEqual([]);
    expect(doneAction(voice)).toBe(2);
    expect(doneAction(compile('audio', "OneShot.ar(sample('s'), { trig: Impulse.kr(2) })"))).toBe(0);
  });

  it('Slice chops a sample and ends a voice at the slice end', () => {
    const v = compile('voice', "Slice.ar(sample('s'), { index: param('index', 0, [0, 15, 'lin', 1]), slices: 16, reverse: param('rev', 0) })");
    expect(v.warnings).toEqual([]);
    const env = v.data.ugens.find((u) => u.name === 'EnvGen')!;
    expect(env.inputs).toHaveLength(21);
    expect(compile('audio', "Slice.ar(sample('s'), { index: 3, trig: Impulse.kr(4) })").shape.channels).toBe(2);
  });

  it('Grains makes a stereo cloud from a stereo sample', () => {
    const g = compile('audio', "Grains.ar(sample('s'), { position: param('pos', 0.5), density: 30, size: 0.1, sync: true, voices: 6 })");
    expect(g.shape.channels).toBe(2);
    expect(g.data.ugens.filter((u) => u.name === 'BufRd')).toHaveLength(6);
    expect(g.data.ugens.filter((u) => u.name === 'Balance2')).toHaveLength(6);
  });

  it('BeatPhase follows the session clock at audio rate', () => {
    const b = compile('audio', 'SinOsc.ar(220) * (BeatPhase.ar(1) < 0.25)');
    expect(b.data.ugens.some((u) => u.name === 'Phasor' && u.rate === 2)).toBe(true);
  });
});
