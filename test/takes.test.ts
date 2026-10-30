import { describe, expect, it } from 'vitest';
import { Recorder } from '../src/app/recorder';
import { Peaks, pcm24, takeWav, wavHeader, type Take } from '../src/app/takes';
import type { Engine } from '../src/engine/engine';
import { MASTER_DELAY } from '../src/engine/system-defs';
import { MixTap } from '../src/engine/tap';

const SR = 48000;
const CHUNK = 4096;

/** A tap with the worklet faked: chunks go in by hand. */
function fakeTap(tap: MixTap) {
  const t = tap as unknown as { node: unknown; onMessage(m: unknown): void; sampleRate: number };
  t.sampleRate = SR;
  t.node = { port: { postMessage: (m: { type: string }) => m.type === 'flush' && t.onMessage({ type: 'flushed' }) }, disconnect() {} };
  tap.setMinutes(1);
  let frame = 0;
  return {
    /** `frames` more frames of audio, `value(frame)` per sample. */
    feed(frames: number, value: (f: number) => number = () => 0) {
      for (let done = 0; done < frames; done += CHUNK) {
        const data = new Float32Array(CHUNK * 2);
        for (let i = 0; i < CHUNK; i++) data[2 * i] = data[2 * i + 1] = value(frame + i);
        t.onMessage({ type: 'chunk', frame, frames: CHUNK, buffer: data.buffer });
        frame += CHUNK;
      }
    },
    skip(frames: number) {
      frame += frames;
    },
    get frame() {
      return frame;
    },
  };
}

describe('takes on disk', () => {
  it('24-bit PCM: full scale, halfway, clipped, NaN', () => {
    const b = pcm24(Float32Array.from([0, 1, -1, 0.5, 2, NaN]));
    expect([...b.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect([...b.subarray(3, 6)]).toEqual([0xff, 0xff, 0x7f]);
    expect([...b.subarray(6, 9)]).toEqual([0, 0, 0x80]);
    expect([...b.subarray(9, 12)]).toEqual([0, 0, 0x40]);
    expect([...b.subarray(12, 15)]).toEqual([0xff, 0xff, 0x7f]);
    expect([...b.subarray(15, 18)]).toEqual([0, 0, 0]);
  });

  it('a WAV header that says 24-bit stereo', () => {
    const v = new DataView(wavHeader(1000, 2, SR));
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(SR);
    expect(v.getUint16(34, true)).toBe(24);
    expect(v.getUint32(40, true)).toBe(6000);
  });

  it('a take’s file holds its own frames, not a stopped take’s overrun', async () => {
    const take = { frames: 3, channels: 2, sampleRate: SR } as Take;
    const blob = takeWav(take, [new Uint8Array(12), new Uint8Array(12)]);
    expect(blob.size).toBe(44 + 18);
    const v = new DataView(await blob.slice(0, 44).arrayBuffer());
    expect(v.getUint32(40, true)).toBe(18);
  });

  it('peaks: min and max of the mono mix per bucket', () => {
    const p = new Peaks(2);
    p.push(Float32Array.from([0.5, 0.5, -1, 0, 0.2, 0.2]), 3);
    expect([...p.result()].map((x) => Math.round(x * 100) / 100)).toEqual([-0.5, 0.5, 0.2, 0.2]);
  });
});

describe('the tap’s ring', () => {
  it('reads by frame (silence in gaps) and copies the last frames across them', () => {
    const tap = new MixTap(() => ({ ctx: null, node: null }));
    const feed = fakeTap(tap);
    feed.feed(CHUNK, (f) => f / 1e6);
    feed.skip(CHUNK); // the sound was stopped
    feed.feed(CHUNK, (f) => f / 1e6);
    const r = tap.read(CHUNK - 2, 2 * CHUNK + 2);
    expect(r[0]).toBeCloseTo((CHUNK - 2) / 1e6, 9);
    expect(r[4]).toBe(0);
    expect(r[(CHUNK + 2) * 2]).toBeCloseTo((2 * CHUNK) / 1e6, 9);
    const last = tap.copyLast(CHUNK + 1);
    expect(last[0]).toBeCloseTo((CHUNK - 1) / 1e6, 9);
    expect(last[2]).toBeCloseTo((2 * CHUNK) / 1e6, 9);
  });

  it('keeps the newest minutes and lets the oldest go', () => {
    const tap = new MixTap(() => ({ ctx: null, node: null }));
    const feed = fakeTap(tap);
    feed.feed(SR * 61);
    expect(tap.held).toBeGreaterThanOrEqual(SR * 60);
    expect(tap.held).toBeLessThan(SR * 60 + CHUNK);
  });
});

describe('the recorder', () => {
  const BPM = 120; // a bar is 2 s, 96000 frames
  const K = 3000; // NTP at AudioContext time 0
  function setup() {
    let now = 0;
    const clock = {
      nowAt: (t: number) => t + K,
      beatAtTime: (ntp: number) => ((ntp - K) * BPM) / 60,
      timeAtBeat: (beat: number) => K + (beat * 60) / BPM,
      getBpm: () => BPM,
    };
    const ctx = { sampleRate: SR, get currentTime() { return now; }, getOutputTimestamp: () => ({ contextTime: now, performanceTime: performance.now() }), outputLatency: 0, baseLatency: 0 };
    const engine = { sonic: { clock, audioContext: ctx, node: null } } as unknown as Engine;
    const finished: Take[] = [];
    const problems: string[] = [];
    const rec = new Recorder(engine, { changed() {}, patchTitle: () => 'test patch', finished: (t) => finished.push(t), problem: (m) => problems.push(m) });
    const feed = fakeTap(rec.tap);
    return { rec, feed, finished, problems, at: (seconds: number) => (now = seconds) };
  }
  const BAR = 96000;
  /** Where a bar line on the grid comes out of the master. */
  const OUT = (bar: number) => bar * BAR + Math.round(MASTER_DELAY * SR);
  const click = (f: number) => (f === OUT(1) || f === OUT(2) ? 1 : 0);

  it('starts on the next bar line and ends on the bar line after the second press: whole bars', async () => {
    const { rec, feed, finished, at } = setup();
    feed.feed(BAR / 2, click);
    at(0.95); // beat 1.9
    rec.toggle();
    expect(rec.rec).toMatchObject({ phase: 'armed', startBeat: 4, startFrame: OUT(1) });
    feed.feed(BAR, click);
    expect(rec.rec?.phase).toBe('recording');
    at(3); // beat 6
    rec.toggle();
    expect(rec.rec).toMatchObject({ phase: 'finishing', endBeat: 8, endFrame: OUT(2) });
    feed.feed(BAR * 1.5, click);
    await rec.settled();
    expect(finished).toHaveLength(1);
    const take = finished[0];
    expect(take).toMatchObject({ kind: 'recording', name: 'take 1', frames: BAR, bars: 1, bpm: BPM, open: false, patch: 'test patch' });
    // Its first frame is the downbeat's click; the next bar's click is just past its end.
    const bytes = new Uint8Array(await (await rec.wav(take)).arrayBuffer());
    expect([...bytes.subarray(44, 47)]).toEqual([0xff, 0xff, 0x7f]);
    expect(bytes.length).toBe(44 + BAR * 6);
    expect(rec.rec).toBeNull();
  });

  it('a press just after the downbeat means that downbeat', () => {
    const { rec, feed, at } = setup();
    feed.feed(BAR * 1.2);
    at(2.05 + MASTER_DELAY); // 50 ms after the bar line at 2 s is heard
    rec.toggle();
    expect(rec.rec).toMatchObject({ phase: 'recording', startFrame: OUT(1), startBeat: 4 });
  });

  it('pressed twice while armed, it never happened; ⌘. ends it off the grid', async () => {
    const { rec, feed, finished, at } = setup();
    at(0.5);
    rec.toggle();
    rec.toggle();
    expect(rec.rec).toBeNull();
    rec.toggle();
    feed.feed(BAR * 1.5);
    at(2.5);
    rec.endNow(0.15);
    feed.feed(BAR);
    await rec.settled();
    expect(finished[0].frames).toBe(Math.round(2.65 * SR) - OUT(1));
    expect(finished[0].bars).toBeUndefined();
  });

  it('capture keeps the last minutes, without the silence at either end', async () => {
    const { rec, feed, finished, problems } = setup();
    feed.feed(SR * 2);
    expect(await rec.capture()).toBeNull();
    expect(problems[0]).toMatch(/silent/);
    feed.feed(SR, () => 0.5);
    feed.feed(SR / 2);
    const take = await rec.capture();
    expect(take).toMatchObject({ kind: 'capture', name: 'capture 1' });
    // One second of sound (to the chunk), plus 50 ms either side.
    expect(Math.abs(take!.frames - (SR + 0.1 * SR))).toBeLessThan(CHUNK);
    expect(finished).toEqual([take]);
  });
});
