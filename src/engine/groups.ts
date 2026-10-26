// The engine's node-tree layout, by role.
export const GROUPS = {
  root: 1,
  control: 10, // control-rate modules (LFOs, sequencers, envelopes)
  modulation: 11, // modulation sums, read by everything after them
  audio: 12, // audio modules and voice groups, topologically ordered
  monitor: 13, // module → master mix
  master: 14,
} as const;
