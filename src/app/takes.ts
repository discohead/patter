// Takes: recordings of the mix (● REC, ⌥R) and captures of its last minutes
// (⟲, ⌥C). They're kept in this browser (IndexedDB) while they're made, a
// couple of seconds at a time, so a take survives a reload — even one the
// page closed in the middle of — until it's downloaded or deleted. The audio
// is stored as 24-bit PCM, exactly as it goes into the WAV file.

export interface Take {
  id: string;
  kind: 'recording' | 'capture';
  name: string;
  created: number;
  sampleRate: number;
  channels: number;
  frames: number;
  /** Whole bars: a recording that started and ended on bar lines (at `bpm`, when it started). */
  bars?: number;
  bpm?: number;
  /** The title of the patch it's a take of. */
  patch: string;
  /** Waveform: [min, max] pairs of the mono mix, one pair per PEAK_SECONDS. */
  peaks: Float32Array;
  /** Still being written (after a reload: the page closed while it was). */
  open: boolean;
  /** When it was last written (ms). */
  updated?: number;
  /** This browser wouldn't store (all of) it: it's in memory until downloaded. */
  volatile?: boolean;
}

export const PEAK_SECONDS = 0.05;
const BYTES = 3;

/** Min/max of the mono mix per bucket, built a chunk at a time. */
export class Peaks {
  private out: number[] = [];
  private min = Infinity;
  private max = -Infinity;
  private n = 0;

  constructor(private readonly bucket: number) {}

  push(interleaved: Float32Array, frames: number): void {
    for (let i = 0; i < frames; i++) {
      const v = (interleaved[2 * i] + interleaved[2 * i + 1]) * 0.5;
      if (v < this.min) this.min = v;
      if (v > this.max) this.max = v;
      if (++this.n === this.bucket) {
        this.out.push(this.min, this.max);
        this.min = Infinity;
        this.max = -Infinity;
        this.n = 0;
      }
    }
  }

  result(): Float32Array {
    return Float32Array.from(this.n ? [...this.out, this.min, this.max] : this.out);
  }
}

/** Float samples → 24-bit little-endian PCM (clipped to ±1; NaN → 0). */
export function pcm24(samples: Float32Array, count = samples.length): Uint8Array {
  const out = new Uint8Array(count * BYTES);
  for (let i = 0, o = 0; i < count; i++, o += BYTES) {
    let x = samples[i];
    x = x > 1 ? 1 : x < -1 ? -1 : x;
    const v = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
    out[o] = v & 255;
    out[o + 1] = (v >> 8) & 255;
    out[o + 2] = (v >> 16) & 255;
  }
  return out;
}

/** The 44-byte header of a 24-bit PCM WAV file. */
export function wavHeader(frames: number, channels: number, sampleRate: number): ArrayBuffer {
  const block = channels * BYTES;
  const data = frames * block;
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const ascii = (at: number, text: string) => [...text].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * block, true);
  v.setUint16(32, block, true);
  v.setUint16(34, BYTES * 8, true);
  ascii(36, 'data');
  v.setUint32(40, data, true);
  return buf;
}

/** A take's WAV file from its stored parts (only its own frames: a stopped take's last part can run past its end). */
export function takeWav(take: Take, parts: Uint8Array[]): Blob {
  let left = take.frames * take.channels * BYTES;
  const body: Uint8Array[] = [];
  for (const p of parts) {
    if (left <= 0) break;
    const use = p.length <= left ? p : p.subarray(0, left);
    body.push(use);
    left -= use.length;
  }
  const frames = (take.frames * take.channels * BYTES - Math.max(0, left)) / (take.channels * BYTES);
  return new Blob([wavHeader(frames, take.channels, take.sampleRate), ...(body as BlobPart[])], { type: 'audio/wav' });
}

/** A file name for a take: patch, take, when. */
export function takeFileName(take: Take): string {
  const d = new Date(take.created);
  const pad = (n: number) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return `${safe(take.patch) || 'patter'} - ${safe(take.name)} ${when}.wav`;
}

// ── storage ─────────────────────────────────────────────────────────────────

const DB_NAME = 'patter-takes';
type PartKey = [string, number];

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });
}

/**
 * Takes in IndexedDB: their metadata in 'takes', their audio in 'parts' under
 * [id, index]. Writes never throw: a part this browser won't store stays in
 * memory and its take is marked volatile (download it before leaving).
 */
export class TakeStore {
  private opening: Promise<IDBDatabase> | null = null;
  private memory = new Map<string, Map<number, Uint8Array>>();

  private db(): Promise<IDBDatabase> {
    if (!this.opening) {
      this.opening = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB here'));
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('takes', { keyPath: 'id' });
          r.result.createObjectStore('parts');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      this.opening.catch(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  async list(): Promise<Take[]> {
    try {
      const db = await this.db();
      const takes = await request(db.transaction('takes').objectStore('takes').getAll() as IDBRequest<Take[]>);
      return takes.sort((a, b) => b.created - a.created);
    } catch {
      return [];
    }
  }

  async put(take: Take): Promise<void> {
    if (take.volatile) return;
    try {
      const db = await this.db();
      const tx = db.transaction('takes', 'readwrite');
      tx.objectStore('takes').put(take);
      await done(tx);
    } catch {
      take.volatile = true;
    }
  }

  async putPart(take: Take, index: number, bytes: Uint8Array): Promise<void> {
    if (!take.volatile) {
      try {
        const db = await this.db();
        const tx = db.transaction('parts', 'readwrite');
        tx.objectStore('parts').put(bytes, [take.id, index] satisfies PartKey);
        await done(tx);
        return;
      } catch {
        take.volatile = true;
      }
    }
    let m = this.memory.get(take.id);
    if (!m) this.memory.set(take.id, (m = new Map()));
    m.set(index, bytes);
  }

  /** A take's parts, in order (stored ones and any kept in memory). */
  async parts(take: Take): Promise<Uint8Array[]> {
    const byIndex = new Map<number, Uint8Array>();
    try {
      const db = await this.db();
      const store = db.transaction('parts').objectStore('parts');
      const range = IDBKeyRange.bound([take.id, 0], [take.id, Infinity]);
      const [keys, values] = await Promise.all([request(store.getAllKeys(range)), request(store.getAll(range) as IDBRequest<Uint8Array[]>)]);
      keys.forEach((k, i) => byIndex.set((k as PartKey)[1], values[i]));
    } catch {
      /* only what's in memory, then */
    }
    for (const [i, b] of this.memory.get(take.id) ?? []) byIndex.set(i, b);
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  }

  async remove(take: Take): Promise<void> {
    this.memory.delete(take.id);
    try {
      const db = await this.db();
      const tx = db.transaction(['takes', 'parts'], 'readwrite');
      tx.objectStore('takes').delete(take.id);
      tx.objectStore('parts').delete(IDBKeyRange.bound([take.id, 0], [take.id, Infinity]));
      await done(tx);
    } catch {
      /* nothing stored */
    }
  }
}
