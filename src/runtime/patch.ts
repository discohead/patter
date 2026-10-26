// The patch document: the whole running system as data. The agent and the
// UI both edit it through Runtime; it is what gets saved, restored, undone.
//
// Patches are hierarchical. Modules and subpatches have paths ('voice/env');
// a subpatch is a scope with an interface — inlets, outlets, controls — so
// from outside it looks exactly like a module. An abstraction is a reusable
// subpatch definition; its instances are subpatches linked to it.

import type { ModuleKind } from './module-def';

export interface ModuleDoc {
  kind: ModuleKind;
  code: string;
  /** Knob values that differ from the code's defaults. */
  params: Record<string, number>;
  /** Monitored to the master mix (audio and voice modules). */
  play: boolean;
  level: number;
  pan: number;
  mute: boolean;
  /** Crossfade time when the code is replaced. */
  fadeTime: number;
  description?: string;
}

export interface InletDoc {
  /** The source, as a ref in the parent's scope ('osc', 'lfo', 'seq.gate'); null = unconnected. */
  from: string | null;
  /** Shape used when unconnected (and to check connections). */
  rate: 'audio' | 'control';
  channels: number;
  description?: string;
}

export interface SubpatchDoc {
  description?: string;
  inlets: Record<string, InletDoc>;
  /** Outlet name → an inner ref ('vca', 'env.gate'). The first outlet is the main output. */
  outlets: Record<string, string>;
  /**
   * Controls on the subpatch's face — its own performance panel. Name → an
   * inner param ref ('filter.cutoff') or an inner macro ('macro:bright').
   */
  controls: Record<string, string>;
  /** The abstraction this subpatch is an instance of. */
  abstraction?: string;
}

export interface AbstractionDoc {
  description?: string;
  /** Modules relative to the abstraction root ('osc', 'env/adsr'). */
  modules: Record<string, Pick<ModuleDoc, 'kind' | 'code' | 'params' | 'play' | 'level' | 'pan' | 'fadeTime' | 'description'>>;
  /** Nested subpatches, relative paths; '' is the abstraction's own interface. */
  subpatches: Record<string, SubpatchDoc>;
  /** Internal routes, relative refs. */
  mods: ModRoute[];
  /** Macros inside, relative names. */
  macros: Record<string, MacroDoc>;
  /** Knob values inside nested instances that differ from their own abstraction ('env/adsr.attack'). */
  overrides?: Record<string, number>;
}

export interface ModRoute {
  /** 'lfo', 'seq.gate', 'voice/lfo', 'macro:dark' */
  source: string;
  /** 'filter.cutoff', 'voice/filter.cutoff' */
  target: string;
  /** In knob-range units: 1 sweeps the whole range. */
  amount: number;
}

export interface MacroDoc {
  value: number;
  label?: string;
  description?: string;
  /** Bipolar macros add (value*2-1)*amount: centre is neutral. */
  bipolar?: boolean;
}

export interface RoutineDoc {
  code: string;
  playing: boolean;
  /** Start/swap on a multiple of this many beats. */
  quant: number;
  description?: string;
}

export interface SurfaceItem {
  /** 'filter.cutoff', 'voice.cutoff' (a subpatch control) or 'macro:dark' */
  ref: string;
  label?: string;
  group?: string;
}

export interface PatchDoc {
  version: 2;
  title: string;
  bpm: number;
  /** Every module, by full path. */
  modules: Record<string, ModuleDoc>;
  /** Every subpatch, by full path. */
  subpatches: Record<string, SubpatchDoc>;
  /** Reusable subpatch definitions. */
  abstractions: Record<string, AbstractionDoc>;
  /** Routes, with full-path refs. */
  mods: ModRoute[];
  /** Macros by full path ('dark', 'voice/bright'). */
  macros: Record<string, MacroDoc>;
  routines: Record<string, RoutineDoc>;
  /** The root performance panel, in order. Empty: show everything. */
  surface: SurfaceItem[];
  master: { level: number };
  notes?: string;
}

export function emptyPatch(): PatchDoc {
  return {
    version: 2,
    title: 'untitled patch',
    bpm: 110,
    modules: {},
    subpatches: {},
    abstractions: {},
    mods: [],
    macros: {},
    routines: {},
    surface: [],
    master: { level: 0.8 },
  };
}

/** Bring an older or partial document up to the current shape. */
export function migratePatch(raw: unknown): PatchDoc {
  const d = { ...emptyPatch(), ...(raw as Partial<PatchDoc>) } as PatchDoc;
  d.version = 2;
  d.subpatches ??= {};
  d.abstractions ??= {};
  return d;
}

// ── names and paths ─────────────────────────────────────────────────────────

export const SEGMENT = /^[a-z][a-z0-9_]{0,31}$/;

export function checkSegment(name: string, what = 'names'): void {
  if (!SEGMENT.test(name)) {
    throw new Error(`${what} are lowercase identifiers (a-z, 0-9, _), max 32 chars: '${name}'`);
  }
}

/** A full path: segments joined by '/', e.g. 'voice/env'. */
export function checkPath(path: string, what = 'module names'): void {
  if (!path) throw new Error(`${what} can't be empty`);
  for (const seg of path.split('/')) checkSegment(seg, what);
}

/** @deprecated kept for older callers; paths are checked with checkPath. */
export const checkModuleName = (name: string) => checkPath(name);

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function leafOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function join(scope: string, name: string): string {
  return scope ? `${scope}/${name}` : name;
}

/** Is `path` inside (or equal to) `scope`? */
export function within(path: string, scope: string): boolean {
  return !scope || path === scope || path.startsWith(`${scope}/`);
}

/** `path` relative to `scope` ('voice/env/adsr' in 'voice' → 'env/adsr'). */
export function relativeTo(path: string, scope: string): string {
  if (!scope) return path;
  if (path === scope) return '';
  if (!path.startsWith(`${scope}/`)) throw new Error(`'${path}' is not inside '${scope}'`);
  return path.slice(scope.length + 1);
}

export function clonePatch(p: PatchDoc): PatchDoc {
  return JSON.parse(JSON.stringify(p));
}
