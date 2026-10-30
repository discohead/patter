// An Engine stand-in for runtime tests: records every OSC message, hands out
// node ids and buses, accepts every SynthDef.

import type { Engine } from '../src/engine/engine';

export type Msg = [string, ...unknown[]];

export class FakeEngine {
  sent: Msg[] = [];
  defs = new Set<string>();
  freedDefs: string[] = [];
  meters = new Map();
  masterMeter = { peak: [0, 0], rms: [0, 0], time: 0 };
  zeroBus = 0;
  masterBus = 62;
  masterNode = 999;
  booted = true;
  sampleRate = 48000;
  log: unknown[] = [];
  private node = 1000;
  private audio = 64;
  private control = 64;
  private meter = 1;

  send(address: string, ...args: unknown[]) {
    this.sent.push([address, ...args]);
  }
  bundle(_time: number | null, packets: Msg[]) {
    for (const p of packets) this.sent.push(p);
  }
  async loadDef(_bytes: Uint8Array, name: string) {
    this.defs.add(name);
  }
  freeDef(name: string) {
    this.freedDefs.push(name);
  }
  nextNodeId() {
    return this.node++;
  }
  allocAudio(n: number) {
    const b = this.audio;
    this.audio += n;
    return b;
  }
  freeAudio() {}
  allocControl(n: number) {
    const b = this.control;
    this.control += n;
    return b;
  }
  freeControl() {}
  nextMeterId() {
    return this.meter++;
  }
  info() {}
  recent() {
    return [];
  }

  /** Messages since the last call. */
  take(): Msg[] {
    const out = this.sent;
    this.sent = [];
    return out;
  }
}

export const asEngine = (f: FakeEngine) => f as unknown as Engine;

import type { LoadedSample, SampleSource } from '../src/engine/samples';

/** A sample store that "loads" anything instantly, with shapes you set per source. */
export class FakeBank implements SampleSource {
  shapes: Record<string, { channels: number; frames: number }> = {};
  kept: Set<string> | null = null;
  private loaded = new Map<string, LoadedSample>();
  private next = 16;

  async ensure(src: string): Promise<LoadedSample> {
    let s = this.loaded.get(src);
    if (!s) {
      const shape = this.shapes[src] ?? { channels: 2, frames: 96000 };
      s = {
        src,
        bufnum: this.next++,
        channels: shape.channels,
        frames: shape.frames,
        sampleRate: 48000,
        duration: shape.frames / 48000,
        peaks: new Float32Array(0),
        analysis: { peakDb: -3, rmsDb: -15, onsets: [0], bpm: 120, beats: 4, beatsCandidates: [4], pitchHz: null, root: null, pitchConfidence: 0, kind: 'loop' },
      };
      this.loaded.set(src, s);
    }
    return s;
  }

  get(src: string): LoadedSample | undefined {
    return this.loaded.get(src);
  }

  keepOnly(srcs: Set<string>): void {
    this.kept = new Set(srcs);
  }
}
