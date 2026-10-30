// The mixer's arithmetic: which modules get a strip (everything that plays
// into the master), and the fader law — position ↔ dB, with 0 dB three
// quarters of the way up and +6 dB at the top. Meters use the same law, so a
// meter's 0 dB lines up with the fader's.

import type { ModuleKind } from '../runtime/module-def';
import type { Runtime } from '../runtime/runtime';

export interface MixChannel {
  path: string;
  kind: ModuleKind;
  channels: number;
  meterId: number;
}

/** A strip for every module that plays into the master, in patch order. */
export function mixChannels(rt: Runtime): MixChannel[] {
  return Object.entries(rt.doc.modules).flatMap(([path, d]) => {
    if (!d.play || d.kind === 'control') return [];
    const live = rt.module(path);
    if (!live || live.compiled.shape.rate !== 'audio') return [];
    return [{ path, kind: d.kind, channels: live.compiled.shape.channels, meterId: live.meterId }];
  });
}

const LAW: [number, number][] = [
  [0.02, -80],
  [0.05, -60],
  [0.15, -40],
  [0.3, -24],
  [0.45, -12],
  [0.6, -6],
  [0.75, 0],
  [1, 6],
];

export const MAX_DB = 6;

/** Fader position (0..1) → dB (−Infinity at the bottom). */
export function faderDb(pos: number): number {
  if (pos <= LAW[0][0]) return -Infinity;
  for (let i = 1; i < LAW.length; i++) {
    const [p0, d0] = LAW[i - 1];
    const [p1, d1] = LAW[i];
    if (pos <= p1) return d0 + ((d1 - d0) * (pos - p0)) / (p1 - p0);
  }
  return MAX_DB;
}

/** dB → fader position (0..1). */
export function faderPos(db: number): number {
  if (!(db > LAW[0][1])) return 0;
  for (let i = 1; i < LAW.length; i++) {
    const [p0, d0] = LAW[i - 1];
    const [p1, d1] = LAW[i];
    if (db <= d1) return p0 + ((p1 - p0) * (db - d0)) / (d1 - d0);
  }
  return 1;
}

export const toDb = (gain: number) => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);
export const toGain = (db: number) => (db === -Infinity ? 0 : 10 ** (db / 20));

/** −6.0, +1.5, −∞ */
export function formatDb(db: number): string {
  if (db === -Infinity || db < -99) return '−∞';
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)}`;
}
