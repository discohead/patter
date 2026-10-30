// What a sample is, from its audio: a waveform overview, its loudness, where
// its onsets are, a tempo and a length in beats (for loops) and a pitch (for
// pitched one-shots). It all runs here, on the decoded audio: the engine has
// no Onsets UGen, and the answers are wanted before anything plays.

import { fft } from './analysis';

export interface SampleAnalysis {
  peakDb: number;
  rmsDb: number;
  /** Onset times in seconds, strongest first is not implied: in time order. */
  onsets: number[];
  /** A tempo, when there is a pulse, and the whole number of beats the sample spans at it. */
  bpm: number | null;
  beats: number | null;
  /** Other plausible lengths in beats (half and double time), most likely first. */
  beatsCandidates: number[];
  /** Pitch, when it has a clear one: Hz and the nearest MIDI note (fractional). */
  pitchHz: number | null;
  root: number | null;
  /** 0..1: how sure the pitch is. */
  pitchConfidence: number;
  kind: 'one-shot' | 'loop' | 'texture';
}

const db = (x: number) => (x > 0 ? Math.round(200 * Math.log10(x)) / 10 : -120);

function monoOf(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** A waveform overview: `buckets` [min, max] pairs of the mono mix. */
export function overview(channels: Float32Array[], buckets = 512): Float32Array {
  const mono = monoOf(channels);
  const out = new Float32Array(buckets * 2);
  const per = mono.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let lo = 0, hi = 0;
    const end = Math.min(mono.length, Math.ceil((b + 1) * per));
    for (let i = Math.floor(b * per); i < end; i++) {
      const v = mono[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[2 * b] = lo;
    out[2 * b + 1] = hi;
  }
  return out;
}

/** Spectral flux of the log magnitude spectrum: how much new energy each hop brings. */
function novelty(mono: Float32Array, size: number, hop: number): Float32Array {
  const frames = Math.max(0, Math.floor((mono.length - size) / hop) + 1);
  const out = new Float32Array(frames);
  const win = new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const re = new Float64Array(size), im = new Float64Array(size);
  let prev = new Float64Array(size / 2);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < size; i++) {
      re[i] = mono[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(size / 2);
    let flux = 0;
    for (let k = 1; k < size / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = mag[k] - prev[k];
      if (d > 0) flux += d;
    }
    out[f] = flux;
    prev = mag;
  }
  return out;
}

/** Peaks of the novelty curve above a moving median: the onsets, in hops. */
function pickOnsets(nov: Float32Array, hopSec: number): { at: number; strength: number }[] {
  const out: { at: number; strength: number }[] = [];
  const half = Math.max(2, Math.round(0.1 / hopSec));
  const gap = Math.max(1, Math.round(0.04 / hopSec));
  let max = 0;
  for (const v of nov) max = Math.max(max, v);
  if (max <= 0) return out;
  for (let i = 0; i < nov.length - 1; i++) {
    const v = nov[i];
    // Frame 0 compares with silence before the file: sound at the very start is an onset.
    if ((i > 0 && v < nov[i - 1]) || v < nov[i + 1]) continue;
    const win = Array.from(nov.slice(Math.max(0, i - half), Math.min(nov.length, i + half + 1))).sort((a, b) => a - b);
    const median = win[win.length >> 1];
    if (v < median * 1.5 + 0.08 * max) continue;
    const last = out[out.length - 1];
    if (last && i - last.at < gap) {
      if (v > last.strength) out[out.length - 1] = { at: i, strength: v };
      continue;
    }
    out.push({ at: i, strength: v });
  }
  return out;
}

/** Tempo by autocorrelating the novelty curve, with a preference for 120-ish (log-Gaussian prior). */
function tempoOf(nov: Float32Array, hopSec: number): { bpm: number; strength: number } | null {
  const mean = nov.reduce((a, b) => a + b, 0) / Math.max(1, nov.length);
  const x = Float64Array.from(nov, (v) => v - mean);
  const minLag = Math.round(60 / 190 / hopSec);
  const maxLag = Math.min(x.length - 1, Math.round(60 / 60 / hopSec));
  if (maxLag <= minLag + 2) return null;
  let energy = 0;
  for (const v of x) energy += v * v;
  if (energy <= 0) return null;
  const acf = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    acf[lag] = s / energy;
  }
  let best = -1, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSec);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = acf[lag] * prior;
    if (acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1] && score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (best < 0 || acf[best] < 0.05) return null;
  // Parabolic interpolation around the peak.
  const a = acf[best - 1], b = acf[best], c = acf[best + 1];
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  return { bpm: 60 / ((best + shift) * hopSec), strength: acf[best] };
}

const NICE_BEATS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128];

/** Whole beat counts the sample could span, nearest the tempo estimate first (loops are cut to whole beats). */
function beatCounts(duration: number, bpm: number | null): number[] {
  const fits = NICE_BEATS.filter((n) => {
    const t = (n * 60) / duration;
    return t >= 60 && t <= 200;
  });
  if (!fits.length) return [];
  const target = bpm ?? 120;
  return fits.sort((a, b) => Math.abs(Math.log2((a * 60) / duration / target)) - Math.abs(Math.log2((b * 60) / duration / target)));
}

/** YIN on the loudest stretch after the attack: a fundamental, if there is one. */
function pitchOf(mono: Float32Array, sr: number, startAt: number): { hz: number; confidence: number } | null {
  const size = 2048;
  if (mono.length < size * 2) return null;
  // The loudest 2048-sample window in the second after the attack (skipping the transient).
  const from = Math.min(mono.length - size * 2, Math.max(0, Math.round((startAt + 0.03) * sr)));
  const to = Math.min(mono.length - size * 2, from + sr);
  let at = from, loud = -1;
  for (let off = from; off <= to; off += 512) {
    let e = 0;
    for (let i = 0; i < size; i++) e += mono[off + i] * mono[off + i];
    if (e > loud) {
      loud = e;
      at = off;
    }
  }
  if (loud <= 1e-6) return null;
  const minTau = Math.floor(sr / 1500), maxTau = Math.min(size - 1, Math.floor(sr / 40));
  const d = new Float64Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let s = 0;
    for (let i = 0; i < size; i++) {
      const v = mono[at + i] - mono[at + i + tau];
      s += v * v;
    }
    d[tau] = s;
  }
  // Cumulative mean normalised difference.
  const cm = new Float64Array(maxTau + 1);
  cm[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    run += d[tau];
    cm[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (cm[t] < 0.15) {
      while (t + 1 <= maxTau && cm[t + 1] < cm[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    let best = Infinity;
    for (let t = minTau; t <= maxTau; t++) if (cm[t] < best) [best, tau] = [cm[t], t];
  }
  if (tau <= 0 || tau >= maxTau) return null;
  const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  return { hz: sr / (tau + shift), confidence: Math.max(0, Math.min(1, 1 - b)) };
}

export function analyseSample(channels: Float32Array[], sr: number): SampleAnalysis {
  const mono = monoOf(channels);
  const duration = mono.length / sr;
  let peak = 0, sum = 0;
  for (const v of mono) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  const size = 1024;
  const hop = duration > 30 ? 512 : 256;
  const hopSec = hop / sr;
  const nov = novelty(mono, size, hop);
  const picked = pickOnsets(nov, hopSec);
  // A hop's flux describes the frame that starts there: the onset is about half a window later.
  const onsets = picked.map((o) => Math.max(0, (o.at * hop + size / 2) / sr));
  const tempo = duration >= 1 && picked.length >= 3 ? tempoOf(nov, hopSec) : null;
  const candidates = picked.length >= 3 ? beatCounts(duration, tempo?.bpm ?? null) : [];
  const beats = candidates[0] ?? null;
  // A pulse over several onsets is a loop; a few onsets in a short file is a hit.
  const kind: SampleAnalysis['kind'] = beats !== null && picked.length >= 4 ? 'loop' : picked.length <= 3 && duration < 4 ? 'one-shot' : 'texture';
  const pitch = pitchOf(mono, sr, onsets[0] ?? 0);
  const confident = pitch && pitch.confidence >= 0.75;
  return {
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(sum / Math.max(1, mono.length))),
    onsets: onsets.map((t) => Math.round(t * 1000) / 1000),
    bpm: beats !== null ? Math.round(((beats * 60) / duration) * 100) / 100 : null,
    beats,
    beatsCandidates: candidates.slice(0, 4),
    pitchHz: confident ? Math.round(pitch!.hz * 100) / 100 : null,
    root: confident ? Math.round((69 + 12 * Math.log2(pitch!.hz / 440)) * 100) / 100 : null,
    pitchConfidence: pitch ? Math.round(pitch.confidence * 100) / 100 : 0,
    kind,
  };
}
