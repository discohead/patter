import { describe, expect, it } from 'vitest';
import { analyseSample, overview } from '../src/engine/sample-analysis';

const SR = 48000;

/** A drum-ish loop: a decaying noise burst on every 16th, accented on the beat. */
function loop(bpm: number, beats: number): Float32Array {
  const n = Math.round((beats * 60 * SR) / bpm);
  const out = new Float32Array(n);
  const step = (60 * SR) / bpm / 4;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let s = 0; s * step < n; s++) {
    const amp = s % 4 === 0 ? 0.9 : 0.25;
    const at = Math.round(s * step);
    for (let i = 0; i < 2400 && at + i < n; i++) out[at + i] += amp * rnd() * Math.exp(-i / 300);
  }
  return out;
}

describe('sample analysis', () => {
  it('finds a loop: its onsets, tempo and length in beats', () => {
    const a = analyseSample([loop(120, 8)], SR);
    expect(a.kind).toBe('loop');
    expect(a.beats).toBe(8);
    expect(a.bpm).toBeCloseTo(120, 0);
    expect(a.onsets.length).toBeGreaterThanOrEqual(28);
    expect(a.onsets[0]).toBeLessThan(0.03);
  });

  it('hears the pitch of a tone', () => {
    const n = SR;
    const tone = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) * Math.exp(-i / (SR * 0.6)));
    const a = analyseSample([tone], SR);
    expect(a.pitchHz).toBeCloseTo(220, 0);
    expect(a.root).toBeCloseTo(57, 1);
    expect(a.kind).toBe('one-shot');
  });

  it('draws a min/max overview', () => {
    const o = overview([Float32Array.from({ length: 1000 }, (_, i) => (i < 500 ? 0.5 : -0.25))], 4);
    expect(Array.from(o)).toEqual([0, 0.5, 0, 0.5, -0.25, 0, -0.25, 0]);
  });
});
