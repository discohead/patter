// Signal analysis for listen(): what a module sounds like, in numbers the
// agent can reason about — level, DC, spectrum shape, dominant partials,
// pitch, and how the level moves over time (rhythm).

export interface AudioAnalysis {
  channels: number;
  seconds: number;
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  dc: number;
  silent: boolean;
  clipping: boolean;
  /** Spectral centroid, Hz: the "brightness". */
  centroidHz: number;
  /** Frequency below which 85% of the energy lies. */
  rolloffHz: number;
  /** 0 = tonal, 1 = noise-like (spectral flatness). */
  flatness: number;
  /** Strongest spectral peaks: [Hz, dB relative to the strongest]. */
  partials: [number, number][];
  /** Autocorrelation pitch estimate, when the signal is periodic enough. */
  pitchHz: number | null;
  pitchNote: string | null;
  /** RMS in 50 ms frames over the window, dB (coarse rhythm picture). */
  envelopeDb: number[];
  /** Estimated rate of level pulses, Hz (from the envelope's autocorrelation). */
  pulseHz: number | null;
  /** Stereo only: correlation between channels, 1 = mono, 0 = wide, <0 = phasey. */
  stereoCorrelation: number | null;
}

export interface ControlAnalysis {
  channels: number;
  seconds: number;
  perChannel: { min: number; max: number; mean: number; rateHz: number | null; kind: string }[];
}

const db = (x: number) => (x <= 1e-10 ? -200 : 20 * Math.log10(x));
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(hz: number): string {
  const midi = 69 + 12 * Math.log2(hz / 440);
  const n = Math.round(midi);
  const cents = Math.round((midi - n) * 100);
  return `${NOTE[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}${cents ? ` ${cents > 0 ? '+' : ''}${cents}c` : ''}`;
}

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Average magnitude spectrum over hops of `size` samples (Hann window). */
function spectrum(x: Float32Array, size = 4096): Float64Array {
  const mag = new Float64Array(size / 2);
  if (x.length < size) return mag;
  const hop = size / 2;
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  let frames = 0;
  for (let start = 0; start + size <= x.length; start += hop) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = x[start + i] * win[i];
    fft(re, im);
    for (let k = 0; k < size / 2; k++) mag[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  for (let k = 0; k < mag.length; k++) mag[k] /= frames || 1;
  return mag;
}

function pitch(x: Float32Array, sr: number): number | null {
  // Normalised autocorrelation over a 2048-sample window from the middle.
  const n = Math.min(4096, x.length);
  if (n < 1024) return null;
  const start = Math.floor((x.length - n) / 2);
  const s = x.subarray(start, start + n);
  const minLag = Math.floor(sr / 2000);
  const maxLag = Math.min(Math.floor(sr / 30), n / 2);
  let e0 = 0;
  for (let i = 0; i < n / 2; i++) e0 += s[i] * s[i];
  if (e0 < 1e-8) return null;
  let best = -1, bestLag = 0;
  const r = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let acc = 0, e1 = 0;
    for (let i = 0; i < n / 2; i++) {
      acc += s[i] * s[i + lag];
      e1 += s[i + lag] * s[i + lag];
    }
    r[lag] = acc / Math.sqrt(e0 * e1 + 1e-12);
  }
  // first peak above 0.85 of the global maximum (avoids octave errors)
  let gmax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) gmax = Math.max(gmax, r[lag]);
  if (gmax < 0.6) return null;
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (r[lag] >= 0.85 * gmax && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      best = r[lag];
      bestLag = lag;
      break;
    }
  }
  if (bestLag === 0 || best < 0.6) return null;
  // parabolic interpolation
  const a = r[bestLag - 1], b = r[bestLag], c = r[bestLag + 1];
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  return sr / (bestLag + shift);
}

function pulseRate(env: number[], frameRate: number): number | null {
  if (env.length < 8) return null;
  const lin = env.map((d) => 10 ** (d / 20));
  const mean = lin.reduce((a, b) => a + b, 0) / lin.length;
  const x = lin.map((v) => v - mean);
  const e = x.reduce((a, b) => a + b * b, 0);
  if (e < 1e-9) return null;
  let bestLag = 0, best = 0.3;
  for (let lag = 2; lag < x.length / 2; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < x.length; i++) acc += x[i] * x[i + lag];
    const r = acc / e;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return bestLag ? frameRate / bestLag : null;
}

/** Analyse interleaved audio. */
export function analyseAudio(interleaved: Float32Array, channels: number, sr: number): AudioAnalysis {
  const frames = Math.floor(interleaved.length / channels);
  const mono = new Float32Array(frames);
  let peak = 0, sumSq = 0, sum = 0;
  let clipped = 0;
  for (let i = 0; i < frames; i++) {
    let m = 0;
    for (let c = 0; c < channels; c++) {
      const v = interleaved[i * channels + c];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      sumSq += v * v;
      m += v;
    }
    mono[i] = m / channels;
    sum += mono[i];
  }
  const rms = Math.sqrt(sumSq / Math.max(1, frames * channels));
  const dc = sum / Math.max(1, frames);

  const size = 4096;
  const mag = spectrum(mono, size);
  const binHz = sr / size;
  let total = 0, weighted = 0, logSum = 0, count = 0;
  for (let k = 1; k < mag.length; k++) {
    const p = mag[k] * mag[k];
    total += p;
    weighted += p * k * binHz;
    logSum += Math.log(p + 1e-20);
    count++;
  }
  const centroid = total > 0 ? weighted / total : 0;
  let acc = 0, rolloff = 0;
  for (let k = 1; k < mag.length; k++) {
    acc += mag[k] * mag[k];
    if (acc >= 0.85 * total) {
      rolloff = k * binHz;
      break;
    }
  }
  const arith = total / Math.max(1, count);
  const geo = Math.exp(logSum / Math.max(1, count));
  const flatness = arith > 0 ? Math.min(1, geo / arith) : 1;

  // spectral peaks
  const peaks: [number, number][] = [];
  let maxMag = 0;
  for (let k = 1; k < mag.length; k++) maxMag = Math.max(maxMag, mag[k]);
  for (let k = 2; k < mag.length - 2; k++) {
    if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > mag[k - 2] && mag[k] >= mag[k + 2] && mag[k] > maxMag * 0.03) {
      const a = mag[k - 1], b = mag[k], c = mag[k + 1];
      const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
      peaks.push([(k + shift) * binHz, db(b / (maxMag || 1))]);
    }
  }
  peaks.sort((x, y) => y[1] - x[1]);

  const hz = pitch(mono, sr);
  const frameLen = Math.floor(sr * 0.05);
  const envelope: number[] = [];
  for (let i = 0; i + frameLen <= frames; i += frameLen) {
    let s = 0;
    for (let j = 0; j < frameLen; j++) s += mono[i + j] * mono[i + j];
    envelope.push(round(db(Math.sqrt(s / frameLen)), 0));
  }

  let corr: number | null = null;
  if (channels === 2) {
    let lr = 0, ll = 0, rr = 0;
    for (let i = 0; i < frames; i++) {
      const l = interleaved[i * 2], r = interleaved[i * 2 + 1];
      lr += l * r;
      ll += l * l;
      rr += r * r;
    }
    corr = ll > 0 && rr > 0 ? round(lr / Math.sqrt(ll * rr), 2) : null;
  }

  const silent = peak < 1e-4;
  return {
    channels,
    seconds: round(frames / sr, 2),
    peakDb: round(db(peak)),
    rmsDb: round(db(rms)),
    crestDb: round(db(peak) - db(rms)),
    dc: round(dc, 4),
    silent,
    clipping: clipped > frames * 0.001,
    centroidHz: silent ? 0 : Math.round(centroid),
    rolloffHz: silent ? 0 : Math.round(rolloff),
    flatness: round(flatness, 3),
    partials: silent ? [] : peaks.slice(0, 8).map(([f, d]) => [Math.round(f * 10) / 10, round(d)]),
    pitchHz: hz ? round(hz, 2) : null,
    pitchNote: hz ? noteName(hz) : null,
    envelopeDb: envelope,
    pulseHz: pulseRate(envelope, 20),
    stereoCorrelation: corr,
  };
}

/** Analyse a control-rate signal (sampled at audio rate by the probe). */
export function analyseControl(interleaved: Float32Array, channels: number, sr: number): ControlAnalysis {
  const frames = Math.floor(interleaved.length / channels);
  const perChannel = [];
  for (let c = 0; c < channels; c++) {
    let min = Infinity, max = -Infinity, sum = 0;
    for (let i = 0; i < frames; i++) {
      const v = interleaved[i * channels + c];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    const mean = sum / Math.max(1, frames);
    // crossings of the mean, to estimate a rate
    let crossings = 0;
    let prev = interleaved[c] - mean;
    for (let i = 1; i < frames; i++) {
      const v = interleaved[i * channels + c] - mean;
      if ((prev < 0 && v >= 0) || (prev > 0 && v <= 0)) crossings++;
      prev = v;
    }
    const range = max - min;
    let steps = 0;
    // skip the first block: the probe may start before the bus has a value
    for (let i = 129; i < frames; i++) {
      if (Math.abs(interleaved[i * channels + c] - interleaved[(i - 1) * channels + c]) > range * 0.2) steps++;
    }
    const seconds = frames / sr;
    const kind = range < 1e-6 ? 'constant' : steps > 1 && steps < frames * 0.01 ? (min >= -1e-6 && max <= 1 + 1e-6 && steps > 1 ? 'gate/trigger or stepped' : 'stepped') : 'continuous';
    perChannel.push({
      min: round(min, 4),
      max: round(max, 4),
      mean: round(mean, 4),
      rateHz: crossings > 1 ? round(crossings / 2 / seconds, 2) : null,
      kind,
    });
  }
  return { channels, seconds: round(frames / sr, 2), perChannel };
}
