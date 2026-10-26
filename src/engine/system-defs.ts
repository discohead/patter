// The engine's own SynthDefs — master bus, per-module monitors, modulation
// summing, probes — written in the same patch language the agent uses.

import { buildSynthDef } from '../sc/build';

export const MOD_SLOTS = 8;
export const MONITOR_CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8, 16];

interface SystemDef {
  name: string;
  code: string;
  params: Record<string, number | number[]>;
}

function build(def: SystemDef): Uint8Array {
  return buildSynthDef(def.name, def.params, def.code).bytes;
}

/** Master: mix bus → gain → DC block → limiter → hardware out, with a meter. */
const master: SystemDef = {
  name: 'patter_master',
  params: { inBus: 0, level: 0.8, limit: 1 },
  code: `
    const sig = LeakDC.ar(In.ar(inBus, 2)) * level.lag(0.05);
    const safe = Select.ar(limit, [sig, Limiter.ar(sig, 0.95, 0.01)]);
    SendPeakRMS.kr(safe, 20, 3, '/patter/master', 0);
    Out.ar(0, Sanitize.ar(safe));
  `,
};

/** Monitor: a module's bus → stereo → master mix, metered. */
function monitor(n: number): SystemDef {
  const toStereo = n === 1 ? 'Pan2.ar(sig, pan)' : n === 2 ? 'Balance2.ar(sig[0], sig[1], pan)' : 'Splay.ar(sig, 1, 1, pan)';
  return {
    name: `patter_monitor_${n}`,
    params: { inBus: 0, out: 0, level: 1, pan: 0, mute: 0, gate: 1, fade: 0.05, meterId: 0 },
    code: `
      const sig = InFeedback.ar(inBus, ${n});
      const env = EnvGen.kr(Env.asr(fade, 1, fade, 'sin'), gate, { doneAction: 2 });
      const stereo = ${toStereo} * (level * (1 - mute)).lag(0.05) * env;
      SendPeakRMS.kr(sig, 15, 3, '/patter/meter', meterId);
      Out.ar(out, stereo);
    `,
  };
}

/**
 * Modulation sum for one target parameter: the knob's normalised position
 * plus each source × amount, clipped, mapped through the param's warp, and
 * written to the bus the target control is mapped to.
 * warp: 0 lin, 1 exp, 2 amp (squared).
 */
const modsum: SystemDef = {
  name: 'patter_modsum',
  params: {
    out: 0, pos: 0, min: 0, max: 1, warp: 0, step: 0,
    srcs: Array(MOD_SLOTS).fill(0), amts: Array(MOD_SLOTS).fill(0),
  },
  code: `
    let p = pos.lag(0.03);
    for (let i = 0; i < ${MOD_SLOTS}; i++) p = p + In.kr(srcs[i]) * amts[i];
    p = p.clip(0, 1);
    const lin = min + (max - min) * p;
    const ex = min * (max / min).max(1e-9).pow(p);
    const am = min + (max - min) * p * p;
    let v = Select.kr(warp, [lin, ex, am]);
    v = Select.kr(step > 0, [v, (v / step.max(1e-9)).round(1) * step]);
    Out.kr(out, v);
  `,
};

/** Meter: a bus that isn't monitored still shows its level in the graph. */
function meter(n: number, rate: 'audio' | 'control'): SystemDef {
  const read = rate === 'audio' ? `InFeedback.ar(inBus, ${n})` : `In.kr(inBus, ${n})`;
  return {
    name: `patter_meter_${rate}_${n}`,
    params: { inBus: 0, meterId: 0 },
    code: `SendPeakRMS.kr(${read}, 15, 3, '/patter/meter', meterId);`,
  };
}

/** Probe: copy a bus into a scope slot so the page can analyse it. */
function probe(n: number, rate: 'audio' | 'control'): SystemDef {
  const read = rate === 'audio' ? `InFeedback.ar(inBus, ${n})` : `K2A.ar(In.kr(inBus, ${n}))`;
  return {
    name: `patter_probe_${rate}_${n}`,
    params: { inBus: 0, scope: 0 },
    code: `
      const sig = ${read};
      ScopeOut2.ar(${n === 1 ? '[sig]' : 'sig'}, scope, 8192, 8192);
    `,
  };
}

export function systemDefs(): { name: string; bytes: Uint8Array }[] {
  const defs: SystemDef[] = [master, modsum, ...MONITOR_CHANNELS.map(monitor)];
  for (const n of MONITOR_CHANNELS) defs.push(meter(n, 'audio'), meter(n, 'control'));
  for (const n of [1, 2, 4, 8]) {
    defs.push(probe(n, 'audio'), probe(n, 'control'));
  }
  return defs.map((d) => ({ name: d.name, bytes: build(d) }));
}
