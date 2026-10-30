// Samples in the engine. A source is 'stock:<name>' (Sonic Pi's pack, served
// from /samples) or 'lib:<sha256>' (the person's library, from /api/samples;
// a listener gets the ones on air from /listen/samples).
// Each source is fetched once, decoded here for its waveform and analysis, and
// loaded into one scsynth buffer that every patch name pointing at it shares.
// Buffers nothing uses any more are freed a moment later.

import type { Engine } from './engine';
import { analyseSample, overview, type SampleAnalysis } from './sample-analysis';

export interface LoadedSample {
  src: string;
  bufnum: number;
  channels: number;
  frames: number;
  sampleRate: number;
  duration: number;
  /** Waveform overview: [min, max] pairs of the mono mix. */
  peaks: Float32Array;
  analysis: SampleAnalysis;
}

/** What the runtime needs from a sample store (tests use a fake one). */
export interface SampleSource {
  ensure(src: string): Promise<LoadedSample>;
  get(src: string): LoadedSample | undefined;
  /** Free the buffers of every source not in `srcs`. */
  keepOnly(srcs: Set<string>): void;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function sampleUrl(src: string): string {
  if (src.startsWith('stock:') && /^[\w-]+$/.test(src.slice(6))) return `/samples/${src.slice(6)}.flac`;
  if (src.startsWith('lib:') && SHA256.test(src.slice(4))) return `/api/samples/${src.slice(4)}`;
  throw new Error(`'${src}' isn't a sample source (use 'stock:<name>' for Sonic Pi's pack, or 'lib:<sha256>' for your library)`);
}

/** Buffer numbers below this are left for anything else that wants one. */
const FIRST_BUFFER = 16;

export class SampleBank implements SampleSource {
  /** How a library sample's bytes are fetched (a listener's page asks the broadcast, not the library). */
  fetchLibrary: (hash: string) => Promise<Response> = (hash) => fetch(sampleUrl(`lib:${hash}`), { credentials: 'same-origin' });
  private loading = new Map<string, Promise<LoadedSample>>();
  private loaded = new Map<string, LoadedSample>();
  /** Bytes already in hand (a file just dropped in), so they aren't fetched back. */
  private seeds = new Map<string, ArrayBuffer>();
  private freeBuffers: number[] = [];
  private next = FIRST_BUFFER;
  private releases = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly engine: Engine,
    private readonly maxBuffers = 1024,
  ) {}

  get(src: string): LoadedSample | undefined {
    return this.loaded.get(src);
  }

  all(): LoadedSample[] {
    return [...this.loaded.values()];
  }

  seed(src: string, bytes: ArrayBuffer): void {
    this.seeds.set(src, bytes);
  }

  ensure(src: string): Promise<LoadedSample> {
    const pending = this.releases.get(src);
    if (pending) {
      clearTimeout(pending);
      this.releases.delete(src);
    }
    let p = this.loading.get(src);
    if (!p) {
      p = this.load(src);
      this.loading.set(src, p);
      p.catch(() => this.loading.delete(src));
    }
    return p;
  }

  keepOnly(srcs: Set<string>): void {
    for (const src of this.loading.keys()) {
      if (srcs.has(src) || this.releases.has(src)) continue;
      // Later, so a crossfade away from it can finish (and an undo can take it back).
      this.releases.set(
        src,
        setTimeout(() => {
          this.releases.delete(src);
          void this.free(src);
        }, 4000),
      );
    }
  }

  private async free(src: string) {
    const p = this.loading.get(src);
    this.loading.delete(src);
    const s = await p?.catch(() => null);
    this.loaded.delete(src);
    if (!s) return;
    this.engine.send('/b_free', s.bufnum);
    this.freeBuffers.push(s.bufnum);
  }

  /** An empty buffer to record into (free it, or adopt it as a sample). */
  async allocScratch(frames: number, channels: number): Promise<number> {
    const bufnum = this.allocBuffer();
    try {
      await this.engine.sonic.allocSample(bufnum, frames, channels);
    } catch (e) {
      this.freeBuffers.push(bufnum);
      throw e;
    }
    return bufnum;
  }

  freeScratch(bufnum: number): void {
    this.engine.send('/b_free', bufnum);
    this.freeBuffers.push(bufnum);
  }

  /** A buffer already in the engine (a recording) becomes the sample for `src`, without loading it again. */
  adopt(src: string, bufnum: number, channels: Float32Array[], sampleRate: number): LoadedSample {
    const s: LoadedSample = {
      src,
      bufnum,
      channels: channels.length,
      frames: channels[0].length,
      sampleRate,
      duration: channels[0].length / sampleRate,
      peaks: overview(channels),
      analysis: analyseSample(channels, sampleRate),
    };
    this.loaded.set(src, s);
    this.loading.set(src, Promise.resolve(s));
    return s;
  }

  private allocBuffer(): number {
    const b = this.freeBuffers.pop() ?? this.next++;
    if (b >= this.maxBuffers) throw new Error(`out of sample buffers (${this.maxBuffers - FIRST_BUFFER} in use)`);
    return b;
  }

  private async load(src: string): Promise<LoadedSample> {
    let bytes = this.seeds.get(src);
    if (!bytes) {
      const url = sampleUrl(src);
      const res = src.startsWith('lib:') ? await this.fetchLibrary(src.slice(4)) : await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`couldn't fetch the sample ${src} (HTTP ${res.status})`);
      bytes = await res.arrayBuffer();
    }
    this.seeds.delete(src);
    const ctx = this.engine.sonic.audioContext;
    if (!ctx) throw new Error('start audio first');
    // Decoded here for the waveform and the analysis; SuperSonic decodes the
    // same bytes again into the buffer (it also reads AIFF, which browsers don't).
    let decoded: AudioBuffer | null = null;
    try {
      decoded = await ctx.decodeAudioData(bytes.slice(0));
    } catch {
      decoded = null;
    }
    const bufnum = this.allocBuffer();
    let info;
    try {
      info = await this.engine.sonic.loadSample(bufnum, bytes);
    } catch (e) {
      this.freeBuffers.push(bufnum);
      throw new Error(`the engine couldn't load ${src}: ${(e as Error).message}`);
    }
    const channels = decoded ? Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded!.getChannelData(c)) : [];
    const s: LoadedSample = {
      src,
      bufnum,
      channels: info.numChannels,
      frames: info.numFrames,
      sampleRate: info.sampleRate,
      duration: info.duration,
      peaks: channels.length ? overview(channels) : new Float32Array(0),
      analysis: channels.length
        ? analyseSample(channels, decoded!.sampleRate)
        : { peakDb: 0, rmsDb: 0, onsets: [], bpm: null, beats: null, beatsCandidates: [], pitchHz: null, root: null, pitchConfidence: 0, kind: 'texture' },
    };
    this.loaded.set(src, s);
    return s;
  }
}

/** A 32-bit float WAV file of interleaved samples. */
export function floatWav(interleaved: Float32Array, channels: number, sampleRate: number): ArrayBuffer {
  const bytes = interleaved.length * 4;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const ascii = (at: number, text: string) => [...text].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); // IEEE float
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 4, true);
  v.setUint16(32, channels * 4, true);
  v.setUint16(34, 32, true);
  ascii(36, 'data');
  v.setUint32(40, bytes, true);
  new Float32Array(buf, 44, interleaved.length).set(interleaved);
  return buf;
}
