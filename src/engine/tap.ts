// A tap on everything the engine plays, after the master's limiter: what
// reaches the speakers. patter's own AudioWorklet (public/worklets/patter-tap.js)
// sits beside the speakers and sends the audio here in ~85 ms chunks, each
// stamped with the AudioContext frame it starts at. A ring keeps the last few
// minutes of them: the capture buffer. Recordings read their frames out of the
// same ring, so a recording can start a moment in the past (a press just after
// the downbeat still gets the downbeat).

const CHUNK_FRAMES = 4096;

interface Chunk {
  /** The AudioContext frame it starts at. */
  frame: number;
  frames: number;
  /** Interleaved stereo; the first frames * 2 values are audio. */
  data: Float32Array;
}

/** Where the tap plugs in: the engine's AudioContext and output node (either may come and go). */
export interface TapSource {
  ctx: AudioContext | null;
  node: { connect(destination: AudioNode): unknown } | null;
}

export class MixTap {
  sampleRate = 48000;
  /** Why the tap isn't running, when it isn't. */
  error: string | null = null;
  /**
   * While set, arriving audio stays out of the ring: the sound is stopped,
   * and what was played before the stop is what a capture should find.
   */
  paused = false;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ring: Chunk[] = [];
  private heldFrames = 0;
  private minutes = 5;
  private capacity = 0;
  private listeners = new Set<() => void>();
  private flushWaiters: (() => void)[] = [];
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private attaching: Promise<void> | null = null;

  constructor(private readonly source: () => TapSource) {}

  get running(): boolean {
    return this.node !== null;
  }

  /** Frames in the ring. */
  get held(): number {
    return this.heldFrames;
  }

  /** The frame after the newest audio in the ring. */
  get end(): number {
    const last = this.ring[this.ring.length - 1];
    return last ? last.frame + last.frames : 0;
  }

  async start(minutes: number): Promise<void> {
    this.minutes = minutes;
    await this.attach();
    // Re-plug every few seconds: connecting twice is a no-op, and the engine's
    // node (or its AudioContext) can be replaced under us.
    this.watchdog ??= setInterval(() => {
      void this.attach().catch((e) => {
        this.error = (e as Error).message;
      });
    }, 2000);
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.unplug();
    this.ctx = null;
    this.clear();
  }

  private unplug() {
    if (!this.node) return;
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.node = null;
  }

  setMinutes(minutes: number): void {
    this.minutes = minutes;
    this.capacity = Math.round(minutes * 60 * this.sampleRate);
    this.evict();
  }

  /** Called after every chunk that arrives. */
  onChunk(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Get the audio still in the worklet (up to a chunk) into the ring now. */
  flush(timeoutMs = 300): Promise<void> {
    const node = this.node;
    if (!node) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.flushWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      node.port.postMessage({ type: 'flush' });
    });
  }

  /** Frames [from, to) by AudioContext frame, interleaved stereo; silence where the ring has none. */
  read(from: number, to: number): Float32Array {
    const out = new Float32Array(Math.max(0, to - from) * 2);
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const c = this.ring[i];
      if (c.frame + c.frames <= from) break;
      const a = Math.max(from, c.frame);
      const b = Math.min(to, c.frame + c.frames);
      if (a < b) out.set(c.data.subarray((a - c.frame) * 2, (b - c.frame) * 2), (a - from) * 2);
    }
    return out;
  }

  /** The newest `frames` frames in the ring, in order, across any gaps (time the sound was stopped). */
  copyLast(frames: number): Float32Array {
    const n = Math.min(frames, this.heldFrames);
    const out = new Float32Array(n * 2);
    let at = n;
    for (let i = this.ring.length - 1; i >= 0 && at > 0; i--) {
      const c = this.ring[i];
      const take = Math.min(c.frames, at);
      out.set(c.data.subarray((c.frames - take) * 2, c.frames * 2), (at - take) * 2);
      at -= take;
    }
    return out;
  }

  private attach(): Promise<void> {
    this.attaching ??= this.attachNow().finally(() => {
      this.attaching = null;
    });
    return this.attaching;
  }

  private async attachNow(): Promise<void> {
    const { ctx, node } = this.source();
    if (!ctx || !node) return;
    if (ctx !== this.ctx) {
      // A first start, or the engine came back on a new AudioContext: a new tap
      // (its frames count from zero again, so the old ring can't be read with them).
      this.unplug();
      this.clear();
      this.ctx = ctx;
      this.sampleRate = ctx.sampleRate;
      this.setMinutes(this.minutes);
      try {
        await ctx.audioWorklet.addModule('/worklets/patter-tap.js');
        const tap = new AudioWorkletNode(ctx, 'patter-tap', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { chunkFrames: CHUNK_FRAMES },
        });
        tap.port.onmessage = (e) => this.onMessage(e.data);
        tap.connect(ctx.destination);
        this.node = tap;
        this.error = null;
      } catch (e) {
        this.ctx = null;
        this.error = `the recording tap didn't start: ${(e as Error).message}`;
        throw new Error(this.error);
      }
    }
    if (this.node) node.connect(this.node);
  }

  private onMessage(m: { type: 'chunk'; frame: number; frames: number; buffer: ArrayBuffer } | { type: 'flushed' }) {
    if (m.type === 'flushed') {
      for (const w of this.flushWaiters.splice(0)) w();
      return;
    }
    const chunk: Chunk = { frame: m.frame, frames: m.frames, data: new Float32Array(m.buffer) };
    if (this.paused) {
      this.reuse(chunk);
    } else {
      this.ring.push(chunk);
      this.heldFrames += chunk.frames;
      this.evict();
    }
    for (const fn of this.listeners) fn();
  }

  private evict() {
    while (this.ring.length > 1 && this.heldFrames - this.ring[0].frames >= this.capacity) {
      const old = this.ring.shift()!;
      this.heldFrames -= old.frames;
      this.reuse(old);
    }
  }

  /** Hand a chunk's buffer back to the worklet to fill again. */
  private reuse(c: Chunk) {
    if (this.node && c.data.length === CHUNK_FRAMES * 2) this.node.port.postMessage({ type: 'reuse', buffer: c.data.buffer }, [c.data.buffer]);
  }

  private clear() {
    this.ring = [];
    this.heldFrames = 0;
  }
}
