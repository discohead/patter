import { beforeEach, describe, expect, it, vi } from 'vitest';
import { faderDb, faderPos, formatDb, mixChannels, toDb, toGain } from '../src/app/mix';
import { Runtime } from '../src/runtime/runtime';
import { asEngine, FakeEngine, type Msg } from './fake-engine';

vi.useFakeTimers();

describe('the fader law', () => {
  it('puts 0 dB three quarters of the way up, +6 at the top, silence at the bottom', () => {
    expect(faderPos(0)).toBe(0.75);
    expect(faderDb(0.75)).toBe(0);
    expect(faderDb(1)).toBe(6);
    expect(faderDb(0)).toBe(-Infinity);
    expect(faderPos(-Infinity)).toBe(0);
  });

  it('goes there and back, and only ever up', () => {
    for (const db of [-79, -60, -33.3, -12, -6, -1.5, 0, 2.5, 6]) expect(faderDb(faderPos(db))).toBeCloseTo(db, 9);
    let last = -Infinity;
    for (let p = 0; p <= 1; p += 0.01) {
      const db = faderDb(p);
      expect(db).toBeGreaterThanOrEqual(last);
      last = db;
    }
  });

  it('reads like a console', () => {
    expect(formatDb(0)).toBe('0.0');
    expect(formatDb(-6.02)).toBe('−6.0');
    expect(formatDb(1.54)).toBe('+1.5');
    expect(formatDb(-Infinity)).toBe('−∞');
    expect(toDb(toGain(-6))).toBeCloseTo(-6, 9);
    expect(toGain(-Infinity)).toBe(0);
  });
});

describe('the mixer in the runtime', () => {
  let eng: FakeEngine;
  let rt: Runtime;
  beforeEach(() => {
    eng = new FakeEngine();
    rt = new Runtime(asEngine(eng));
  });

  const OSC = 'SinOsc.ar(220) * 0.1';
  /** The mute each module's monitor was last told. */
  const mutes = (sent: Msg[]) => {
    const out: Record<string, number> = {};
    for (const name of ['a', 'b', 'c']) {
      const mon = rt.module(name)?.monitor;
      for (const m of sent) {
        if ((m[0] === '/n_set' || m[0] === '/s_new') && m.includes(mon) && m.indexOf('mute') > 0) out[name] = m[m.indexOf('mute') + 1] as number;
      }
    }
    return out;
  };

  it('gives a strip to everything that plays into the master', async () => {
    await rt.defineModule('a', { kind: 'audio', code: OSC });
    await rt.defineModule('lfo', { kind: 'control', code: 'SinOsc.kr(1)' });
    await rt.defineModule('dry', { kind: 'audio', code: OSC, play: false });
    await rt.defineModule('v', { kind: 'voice', code: 'SinOsc.ar(440) * EnvGen.kr(Env.perc(), 1, 0.1, 0, 1, 2)' });
    expect(mixChannels(rt).map((c) => c.path)).toEqual(['a', 'v']);
  });

  it('solo silences everything not soloed, and lets go when unsoloed or removed', async () => {
    for (const n of ['a', 'b', 'c']) await rt.defineModule(n, { kind: 'audio', code: OSC });
    eng.take();
    rt.setMonitor('a', { solo: true });
    expect(mutes(eng.take())).toEqual({ a: 0, b: 1, c: 1 });
    expect(rt.silenced('b')).toBe(true);
    rt.setMonitor('b', { solo: true });
    expect(mutes(eng.take())).toMatchObject({ b: 0, c: 1 });
    rt.setMonitor('a', { solo: false });
    rt.setMonitor('b', { solo: false });
    expect(mutes(eng.take())).toEqual({ a: 0, b: 0, c: 0 });
    rt.setMonitor('c', { mute: true });
    rt.setMonitor('a', { solo: true });
    eng.take();
    await rt.removeModule('a');
    expect(mutes(eng.take())).toEqual({ b: 0, c: 1 });
  });

  it('keeps the fader and pan when a module is redefined (the mix is the person’s)', async () => {
    await rt.defineModule('a', { kind: 'audio', code: OSC, level: 0.5 });
    expect(rt.doc.modules.a.level).toBe(0.5);
    rt.setMonitor('a', { level: 0.25, pan: -0.5, solo: true });
    await rt.defineModule('a', { kind: 'audio', code: 'Saw.ar(110) * 0.1', level: 1, pan: 0 });
    expect(rt.doc.modules.a).toMatchObject({ level: 0.25, pan: -0.5, solo: true });
  });

  it('comes back from a saved patch with its solos applied', async () => {
    for (const n of ['a', 'b']) await rt.defineModule(n, { kind: 'audio', code: OSC });
    rt.setMonitor('b', { solo: true, level: 0.7 });
    const saved = structuredClone(rt.doc);
    const rt2 = new Runtime(asEngine(new FakeEngine()));
    await rt2.loadPatch(saved);
    expect(rt2.silenced('a')).toBe(true);
    expect(rt2.doc.modules.b).toMatchObject({ solo: true, level: 0.7 });
  });
});
