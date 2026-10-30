// SuperSonic, set up for patching: the group layout, bus allocation, system
// SynthDefs, meters, and a log of what the engine says.

import { SuperSonic, type OscBundlePacket, type OscMessage } from 'supersonic-scsynth';
import { systemDefs } from './system-defs';
import { CLOCK_BUS, CLOCK_PERIOD } from '../sc/samplers';

export { GROUPS } from './groups';
import { GROUPS } from './groups';

export interface EngineLogEntry {
  time: number;
  kind: 'fail' | 'debug' | 'error' | 'warning' | 'info';
  text: string;
}

export interface Meter {
  peak: number[];
  rms: number[];
  time: number;
}

/** Where a looping sampler is, as it reports itself (in beats of its sample). */
export interface Playhead {
  pos: number;
  start: number;
  length: number;
  beats: number;
  reverse: number;
  rate: number;
  time: number;
}

class BusAllocator {
  private free: [number, number][] = [];
  private next: number;
  constructor(start: number, private readonly end: number) {
    this.next = start;
  }
  alloc(n: number): number {
    for (let i = 0; i < this.free.length; i++) {
      const [start, len] = this.free[i];
      if (len >= n) {
        if (len === n) this.free.splice(i, 1);
        else this.free[i] = [start + n, len - n];
        return start;
      }
    }
    if (this.next + n > this.end) throw new Error('out of buses');
    const b = this.next;
    this.next += n;
    return b;
  }
  release(start: number, n: number): void {
    this.free.push([start, n]);
    this.free.sort((a, b) => a[0] - b[0]);
    // coalesce neighbours
    for (let i = 0; i < this.free.length - 1; ) {
      const [s, l] = this.free[i];
      const [s2, l2] = this.free[i + 1];
      if (s + l === s2) this.free.splice(i, 2, [s, l + l2]);
      else i++;
    }
  }
}

export class Engine {
  readonly sonic: SuperSonic;
  readonly log: EngineLogEntry[] = [];
  private logListeners = new Set<(e: EngineLogEntry) => void>();
  readonly meters = new Map<number, Meter>();
  masterMeter: Meter = { peak: [0, 0], rms: [0, 0], time: 0 };
  /** Looping samplers' playheads, by the module's meter id. */
  readonly playheads = new Map<number, Playhead>();
  private audioBuses = new BusAllocator(64, 1024);
  private controlBuses = new BusAllocator(64, 16384);
  /** A control bus nothing writes: modulation slots point here when empty. */
  readonly zeroBus = 0;
  masterBus = -1;
  masterNode = -1;
  private loadQueue: Promise<unknown> = Promise.resolve();
  /** /b_getn replies awaited, by 'bufnum:start'. */
  private bufferReads = new Map<string, (values: number[]) => void>();
  /** Nodes whose end someone is waiting for. */
  private nodeEnds = new Map<number, () => void>();
  /** Clock probes in flight, by node id. */
  private probes = new Map<number, (enginePhase: number) => void>();
  private calibrating: Promise<number | null> | null = null;
  private calibrationTimer: ReturnType<typeof setInterval> | null = null;
  /** The engine's beat minus the client's, in beats modulo CLOCK_PERIOD (what CLOCK_BUS holds). */
  clockOffset = 0;
  private meterIds = 1;
  booted = false;

  constructor() {
    this.sonic = new SuperSonic({
      workerBaseURL: '/supersonic/workers/',
      coreBaseURL: '/supersonic-core/',
      synthdefBaseURL: '/synthdefs/',
      sampleBaseURL: '/samples/',
      scsynthOptions: {
        maxNodes: 1024, // the node-tree mirror's size; more would be invisible to getTree()
        maxWireBufs: 512,
        realTimeMemorySize: 32768,
        numBuffers: 1024,
      },
    });

    this.sonic.on('in', (msg) => this.onMessage(msg));
    this.sonic.on('debug', (d) => {
      const text = d.text.trim();
      if (text && !this.tracing) this.push('debug', text);
    });
    this.sonic.on('error', (e) => this.push('error', String(e?.message ?? e)));
    this.sonic.on('warning', (w) => this.push('warning', w.message));
  }

  onLog(fn: (e: EngineLogEntry) => void): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  private push(kind: EngineLogEntry['kind'], text: string) {
    const e: EngineLogEntry = { time: performance.now(), kind, text };
    this.log.push(e);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    for (const fn of this.logListeners) fn(e);
  }

  info(text: string) {
    this.push('info', text);
  }

  private onMessage(msg: OscMessage) {
    const [addr, ...args] = msg;
    if (addr === '/patter/meter') {
      // [nodeID, replyID, peak0, rms0, peak1, rms1, ...]
      const id = args[1] as number;
      const vals = args.slice(2) as number[];
      this.meters.set(id, {
        peak: vals.filter((_, i) => i % 2 === 0),
        rms: vals.filter((_, i) => i % 2 === 1),
        time: performance.now(),
      });
    } else if (addr === '/patter/master') {
      const vals = args.slice(2) as number[];
      this.masterMeter = {
        peak: vals.filter((_, i) => i % 2 === 0),
        rms: vals.filter((_, i) => i % 2 === 1),
        time: performance.now(),
      };
    } else if (addr === '/b_setn') {
      this.bufferReads.get(`${args[0]}:${args[1]}`)?.(args.slice(3) as number[]);
    } else if (addr === '/n_end') {
      this.nodeEnds.get(args[0] as number)?.();
    } else if (addr === '/patter/clock') {
      this.probes.get(args[0] as number)?.(args[2] as number);
    } else if (addr === '/patter/playhead') {
      // [nodeID, replyID, pos, start, length, beats, reverse, rate]
      const [pos, start, length, beats, reverse, rate] = args.slice(2) as number[];
      this.playheads.set(args[1] as number, { pos, start, length, beats, reverse, rate, time: performance.now() });
    } else if (addr === '/fail') {
      this.push('fail', args.map(String).join(' '));
    }
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    await this.sonic.init();
    const send = (...m: OscMessage) => this.sonic.send(...(m as [string]));
    // Register for replies the engine pushes (SendReply, SendPeakRMS, /tr, /n_end…).
    send('/notify', 1);
    send('/g_new', GROUPS.root, 0, 0);
    send('/g_new', GROUPS.control, 1, GROUPS.root);
    send('/g_new', GROUPS.modulation, 1, GROUPS.root);
    send('/g_new', GROUPS.audio, 1, GROUPS.root);
    send('/g_new', GROUPS.monitor, 1, GROUPS.root);
    send('/g_new', GROUPS.master, 1, GROUPS.root);
    for (const d of systemDefs()) await this.loadDef(d.bytes, d.name);
    this.masterBus = this.allocAudio(2);
    this.masterNode = this.sonic.nextNodeId();
    send('/s_new', 'patter_master', this.masterNode, 0, GROUPS.master, 'inBus', this.masterBus);
    this.booted = true;
    void this.calibrateClock();
    this.calibrationTimer = setInterval(() => void this.calibrateClock(), 15_000);
    const info = this.sonic.getInfo();
    this.info(`engine up: ${info.sampleRate} Hz, ${this.sonic.mode} mode, boot ${Math.round(info.bootTimeMs ?? 0)} ms`);
  }

  /** Resolves when a node ends (frees itself, or is freed), or rejects after `ms`. */
  nodeEnded(id: number, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.nodeEnds.delete(id);
        reject(new Error('timed out'));
      }, ms);
      this.nodeEnds.set(id, () => {
        clearTimeout(timer);
        this.nodeEnds.delete(id);
        resolve();
      });
    });
  }

  /** A buffer's samples (interleaved), read back over OSC in chunks. */
  async readBuffer(bufnum: number, frames: number, channels: number): Promise<Float32Array> {
    const total = frames * channels;
    const out = new Float32Array(total);
    const chunk = 1600;
    const starts: number[] = [];
    for (let at = 0; at < total; at += chunk) starts.push(at);
    const one = (start: number) =>
      new Promise<void>((resolve, reject) => {
        const key = `${bufnum}:${start}`;
        const timer = setTimeout(() => {
          this.bufferReads.delete(key);
          reject(new Error(`no reply reading buffer ${bufnum} at ${start}`));
        }, 4000);
        this.bufferReads.set(key, (values) => {
          clearTimeout(timer);
          this.bufferReads.delete(key);
          out.set(values, start);
          resolve();
        });
        this.send('/b_getn', bufnum, start, Math.min(chunk, total - start));
      });
    // A few in flight at a time.
    let next = 0;
    const worker = async () => {
      while (next < starts.length) await one(starts[next++]);
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    return out;
  }

  /**
   * Measure how far the engine's beat (LinkPhase) is from the beat grid the
   * client schedules on, and put it on CLOCK_BUS for every clock-locked synth
   * to subtract. Bundles land exactly when stamped, so a probe started at a
   * known client time T reports the engine's beat there — at the start of the
   * block holding T, half a block early on average, which four probes at
   * scattered sub-block positions even out. SuperSonic 0.91 can show a
   * constant offset here; with none this measures zero.
   */
  calibrateClock(): Promise<number | null> {
    if (this.calibrating) return this.calibrating;
    const run = async (): Promise<number | null> => {
      const clock = this.sonic.clock;
      if (!clock || !this.booted) return null;
      const bps = clock.getBpm() / 60;
      const halfBlock = (0.5 * 128) / this.sampleRate;
      const start = clock.now() + 0.15;
      const results = await Promise.all(
        [0, 0.0371, 0.0743, 0.1117].map((dt) => {
          const t = start + dt;
          const id = this.nextNodeId();
          const reply = new Promise<number | null>((resolve) => {
            const timer = setTimeout(() => {
              this.probes.delete(id);
              resolve(null);
            }, 2000);
            this.probes.set(id, (phase) => {
              clearTimeout(timer);
              this.probes.delete(id);
              resolve(phase);
            });
          });
          // At the head of the root, outside the transport's group: it runs while stopped too.
          this.bundle(t, [['/s_new', 'patter_clockprobe', id, 0, 0]]);
          return reply.then((phase) => (phase === null ? null : phase + halfBlock * bps - clock.beatAtTime(t, 4)));
        }),
      );
      const got = results.filter((x): x is number => x !== null);
      if (!got.length) return null;
      // A mean on the circle of CLOCK_PERIOD beats, around the first.
      const wrap = (x: number) => ((x % CLOCK_PERIOD) + CLOCK_PERIOD) % CLOCK_PERIOD;
      const ref = wrap(got[0]);
      const mean = ref + got.reduce((sum, x) => sum + ((((wrap(x) - ref) % CLOCK_PERIOD) + 1.5 * CLOCK_PERIOD) % CLOCK_PERIOD - CLOCK_PERIOD / 2), 0) / got.length;
      this.clockOffset = wrap(mean);
      this.send('/c_set', CLOCK_BUS, this.clockOffset);
      return this.clockOffset;
    };
    this.calibrating = run().finally(() => {
      this.calibrating = null;
    });
    return this.calibrating;
  }

  private pauseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Silence everything and keep its state: fade the master out, then freeze the node tree. */
  pause(): void {
    if (!this.booted) return;
    this.send('/n_set', this.masterNode, 'level', 0);
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      this.send('/n_run', GROUPS.root, 0);
    }, 90);
  }

  /** Unfreeze the node tree and fade the master back up to `level`. */
  resume(level: number): void {
    if (!this.booted) return;
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    this.send('/n_run', GROUPS.root, 1);
    this.send('/n_set', this.masterNode, 'level', level);
  }

  get sampleRate(): number {
    return this.sonic.audioContext?.sampleRate ?? 48000;
  }

  send(address: string, ...args: (string | number | Uint8Array | number[])[]): void {
    this.sonic.send(address, ...(args as never[]));
  }

  /** Send messages as one bundle, at an NTP time or now. */
  bundle(time: number | null, packets: OscBundlePacket[]): void {
    if (packets.length === 0) return;
    const bytes = SuperSonic.osc.encodeBundle(time ?? 1, packets);
    this.sonic.sendOSC(bytes);
  }

  now(): number {
    return this.sonic.clock?.now() ?? SuperSonic.osc.ntpNow();
  }

  nextNodeId(): number {
    return this.sonic.nextNodeId();
  }

  allocAudio(n: number): number {
    return this.audioBuses.alloc(n);
  }
  freeAudio(b: number, n: number): void {
    this.audioBuses.release(b, n);
  }
  allocControl(n: number): number {
    return this.controlBuses.alloc(n);
  }
  freeControl(b: number, n: number): void {
    this.controlBuses.release(b, n);
  }
  nextMeterId(): number {
    return this.meterIds++;
  }

  /**
   * Load SynthDef bytes and wait for the engine's answer, so a definition the
   * engine refuses (an uninstalled UGen, say) is an error here, not silence later.
   */
  loadDef(bytes: Uint8Array, name: string): Promise<void> {
    const run = async () => {
      try {
        await this.sonic.request('/d_recv', [bytes], {
          reply: '/done',
          match: (m) => m[1] === '/d_recv',
          timeoutMs: 5000,
        });
      } catch (e) {
        const reply = (e as { reply?: OscMessage }).reply;
        const why = reply ? reply.slice(2).join(' ') : (e as Error).message;
        throw new Error(`the engine refused SynthDef '${name}': ${why}`);
      }
    };
    const p = this.loadQueue.then(run, run);
    this.loadQueue = p.catch(() => undefined);
    return p;
  }

  freeDef(name: string): void {
    this.send('/d_free', name);
  }

  async queryControls(node: number): Promise<OscMessage> {
    return this.sonic.request('/s_get', [node], { reply: '/n_set', match: (m) => m[1] === node, timeoutMs: 2000 });
  }

  // ── scope streams (SAB mode) ─────────────────────────────────────────────

  private scopesInUse = new Set<number>();

  scopeSchema(): { maxScopes: number; ringFrames: number; channels: number } {
    return SuperSonic.getScopeSchema();
  }

  allocScope(): number {
    const { maxScopes } = this.scopeSchema();
    for (let i = 0; i < maxScopes; i++) {
      if (!this.scopesInUse.has(i)) {
        this.scopesInUse.add(i);
        return i;
      }
    }
    throw new Error('all scope slots are busy; try again in a moment');
  }

  freeScope(i: number): void {
    this.scopesInUse.delete(i);
  }

  /**
   * Record a scope slot for `seconds`, stitching successive windows by the
   * ring's write cursor so nothing is read twice or skipped.
   */
  async recordScope(slot: number, seconds: number): Promise<{ data: Float32Array; channels: number } | null> {
    if (this.sonic.mode !== 'sab') return null;
    const sr = this.sampleRate;
    const want = Math.floor(seconds * sr);
    const { ringFrames } = this.scopeSchema();
    const chunks: Float32Array[] = [];
    let channels = 0;
    let got = 0;
    let lastPos: bigint | null = null;
    const deadline = performance.now() + seconds * 1000 + 2000;
    while (got < want && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      const w = this.sonic.getScope(slot, Math.min(ringFrames, 8192));
      if (!w) continue;
      channels = w.channels;
      const pos = w.writePosition;
      if (lastPos === null) {
        lastPos = pos;
        continue; // start counting from the first cursor we see
      }
      const fresh = Number(pos - lastPos);
      lastPos = pos;
      if (fresh <= 0) continue;
      const n = Math.min(fresh, w.frames);
      chunks.push(w.interleaved.slice((w.frames - n) * channels));
      got += n;
    }
    if (!chunks.length || !channels) return null;
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const data = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      data.set(c, off);
      off += c.length;
    }
    return { data, channels };
  }

  /** scsynth's /n_trace: every UGen's inputs and outputs for one block, from the debug log. */
  private tracing = false;

  async trace(node: number, waitMs = 250): Promise<string[]> {
    const lines: string[] = [];
    const off = this.sonic.on('debug', (d) => lines.push(d.text));
    this.tracing = true;
    try {
      this.send('/n_trace', node);
      await new Promise((r) => setTimeout(r, waitMs));
    } finally {
      off();
      this.tracing = false;
    }
    return compactTrace(lines.flatMap((l) => l.split('\n')).map((l) => l.trim()).filter(Boolean));
  }

  /** Recent log lines (for the agent), optionally only those after a time. */
  recent(since = 0, kinds: EngineLogEntry['kind'][] = ['fail', 'error', 'debug', 'warning']): EngineLogEntry[] {
    return this.log.filter((e) => e.time > since && kinds.includes(e.kind));
  }
}

/** scsynth prints one value per line; fold each unit into `#3 MoogFF in [..] out [..]`. */
function compactTrace(lines: string[]): string[] {
  const out: string[] = [];
  let unit: { head: string; ins: string[]; outs: string[]; mode: 'in' | 'out' | null } | null = null;
  const flush = () => {
    if (unit) out.push(`${unit.head}  in [${unit.ins.join(', ')}]  out [${unit.outs.join(', ')}]`);
    unit = null;
  };
  for (const l of lines) {
    const u = /^unit (\d+) (\S+)/.exec(l);
    if (u) {
      flush();
      unit = { head: `#${u[1]} ${u[2]}`, ins: [], outs: [], mode: null };
    } else if (l === 'in' && unit) unit.mode = 'in';
    else if (l === 'out' && unit) unit.mode = 'out';
    else if (unit && unit.mode) (unit.mode === 'in' ? unit.ins : unit.outs).push(l);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  return out;
}
