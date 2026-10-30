// The knob area, in tabs. "Performance" is the panel of the level you're
// looking at: the top level's exposed controls, or a subpatch's face (its
// controls) — or, until any are chosen, everything at that level. "Selected"
// is whatever is selected in the graph: a module's knobs and the routes into
// them, a subpatch's face and insides, a macro and its targets. The ☆ on a
// knob puts it on (or takes it off) the Performance Panel of the level you're in.
// Then the Mixer (every module's level into the master), the Samples and the
// Recordings (takes of the mix).

import { useState } from 'react';
import { app, useEmitter } from '../app/store';
import type { ModuleKind } from '../runtime/module-def';
import { leafOf, parentOf, relativeTo, within } from '../runtime/patch';
import { childrenOf } from '../runtime/resolve';
import { Knob } from './Knob';
import { mixChannels } from '../app/mix';
import { MixerPanel } from './Mixer';
import { LoopView, SamplesPanel } from './Samples';
import { RecordingsPanel } from './Takes';

const KIND_ACCENT: Record<ModuleKind, string> = {
  audio: 'var(--audio)',
  control: 'var(--control)',
  voice: 'var(--voice)',
};

type Target = { module: string; param: string } | { macro: string };

interface Item {
  key: string;
  target: Target;
  label: string;
  group: string;
}

const keyOf = (t: Target) => ('macro' in t ? `macro:${t.macro}` : `${t.module}.${t.param}`);
const pathOf = (t: Target) => ('macro' in t ? t.macro : t.module);

function resolve(ref: string, scope: string): Target | null {
  try {
    const r = app.runtime.resolveParamRef(ref, scope);
    return 'macro' in r ? { macro: r.macro } : { module: r.module, param: r.param };
  } catch {
    return null;
  }
}

function labelOf(t: Target): string {
  if ('macro' in t) return app.runtime.doc.macros[t.macro]?.label ?? leafOf(t.macro);
  return app.runtime.paramInfo(t.module, t.param)?.label ?? t.param;
}

function moduleItems(path: string, group: string): Item[] {
  return (app.runtime.module(path)?.compiled.params ?? [])
    .filter((p) => p.rate !== 'trigger' && p.name !== 'gate')
    .map((p) => ({ key: `${path}.${p.name}`, target: { module: path, param: p.name }, label: p.label ?? p.name, group }));
}

/** A subpatch's face: its controls. */
function face(sp: string, group: string): Item[] {
  return Object.entries(app.runtime.doc.subpatches[sp]?.controls ?? {}).flatMap(([name, ref]) => {
    const t = resolve(ref, sp);
    return t ? [{ key: `${sp}:${name}`, target: t, label: name, group }] : [];
  });
}

/** Every knob inside a subpatch, grouped by where it lives relative to `scope`. */
function inside(sp: string, scope: string): Item[] {
  const doc = app.runtime.doc;
  const out: Item[] = [];
  for (const [m, d] of Object.entries(doc.macros)) {
    if (within(m, sp)) out.push({ key: `macro:${m}`, target: { macro: m }, label: d.label ?? leafOf(m), group: `${relativeTo(parentOf(m), scope)} macros` });
  }
  for (const m of Object.keys(doc.modules)) if (within(m, sp)) out.push(...moduleItems(m, relativeTo(m, scope)));
  return out;
}

/** Everything at a level: its macros, each module's knobs, each subpatch's face (or its insides). */
function everything(scope: string): Item[] {
  const doc = app.runtime.doc;
  const out: Item[] = [];
  for (const [m, d] of Object.entries(doc.macros)) {
    if (parentOf(m) === scope) out.push({ key: `macro:${m}`, target: { macro: m }, label: d.label ?? leafOf(m), group: 'Macros' });
  }
  const { modules, subpatches } = childrenOf(doc, scope);
  for (const m of modules) out.push(...moduleItems(m, leafOf(m)));
  for (const sp of subpatches) {
    const f = face(sp, relativeTo(sp, scope));
    out.push(...(f.length ? f : inside(sp, scope)));
  }
  return out;
}

function performance(scope: string): { items: Item[]; curated: boolean } {
  const doc = app.runtime.doc;
  if (!scope) {
    if (!doc.surface.length) return { items: everything(''), curated: false };
    const items = doc.surface.flatMap((s) => {
      const t = resolve(s.ref, '');
      if (!t) return [];
      return [{ key: s.ref, target: t, label: s.label ?? labelOf(t), group: s.group ?? ('macro' in t ? 'Macros' : t.module) }];
    });
    return { items, curated: true };
  }
  const f = face(scope, leafOf(scope));
  return f.length ? { items: f, curated: true } : { items: everything(scope), curated: false };
}

// ── pinning: the ☆ ──────────────────────────────────────────────────────────

/** How a target is on the scope's Performance Panel: its surface ref / control name, or null. */
function pinnedAs(scope: string, t: Target): string | null {
  const doc = app.runtime.doc;
  const k = keyOf(t);
  if (!scope) return doc.surface.find((s) => resolve(s.ref, '') && keyOf(resolve(s.ref, '')!) === k)?.ref ?? null;
  const hit = Object.entries(doc.subpatches[scope]?.controls ?? {}).find(([, ref]) => {
    const r = resolve(ref, scope);
    return r && keyOf(r) === k;
  });
  return hit ? hit[0] : null;
}

async function togglePin(scope: string, t: Target) {
  const rt = app.runtime;
  rt.checkpoint();
  const existing = pinnedAs(scope, t);
  if (!scope) {
    rt.setSurface(existing ? rt.doc.surface.filter((s) => s.ref !== existing) : [...rt.doc.surface, { ref: keyOf(t) }]);
    return;
  }
  if (existing) {
    await rt.defineSubpatch(scope, { controls: { [existing]: null } });
    return;
  }
  const rel = relativeTo(pathOf(t), scope);
  const ref = 'macro' in t ? `macro:${rel}` : `${rel}.${t.param}`;
  const taken = rt.doc.subpatches[scope].controls;
  const base = 'macro' in t ? leafOf(t.macro) : t.param;
  let name = taken[base] ? `${leafOf(pathOf(t))}_${base}`.slice(0, 30) : base;
  for (let n = 2; taken[name]; n++) name = `${base.slice(0, 28)}_${n}`;
  await rt.defineSubpatch(scope, { controls: { [name]: ref } });
}

// ── knobs ───────────────────────────────────────────────────────────────────

function ItemKnob({ it, scope }: { it: Item; scope: string }) {
  const rt = app.runtime;
  const t = it.target;
  const canPin = !scope || within(pathOf(t), scope);
  const pin = canPin
    ? {
        pinned: pinnedAs(scope, t) !== null,
        onPin: () => void togglePin(scope, t).catch((e) => app.engine.info(`can't pin: ${(e as Error).message}`)),
      }
    : {};
  if ('macro' in t) {
    const m = rt.doc.macros[t.macro];
    if (!m) return null;
    return (
      <Knob
        label={it.label}
        value={m.value}
        defaultValue={m.bipolar ? 0.5 : 0}
        spec={{ min: 0, max: 1, warp: 'lin' }}
        size={64}
        accent="var(--macro)"
        title={`macro:${t.macro}${m.description ? ` — ${m.description}` : ''}`}
        onChange={(v) => rt.setMacro(t.macro, v)}
        {...pin}
      />
    );
  }
  const info = rt.paramInfo(t.module, t.param);
  if (!info) return null;
  const kind = rt.doc.modules[t.module]?.kind;
  return (
    <Knob
      label={it.label}
      value={rt.paramValue(t.module, t.param)}
      defaultValue={info.default}
      spec={info.spec}
      accent={kind ? KIND_ACCENT[kind] : undefined}
      modulated={rt.doc.mods.some((m) => m.target === keyOf(t))}
      title={`${keyOf(t)}${info.doc ? ` — ${info.doc}` : ''}`}
      onChange={(v) => rt.setParam(t.module, t.param, v)}
      {...pin}
    />
  );
}

function Groups({ items, scope }: { items: Item[]; scope: string }) {
  const groups = new Map<string, Item[]>();
  for (const it of items) groups.set(it.group, [...(groups.get(it.group) ?? []), it]);
  const doc = app.runtime.doc;
  return (
    <>
      {[...groups.entries()].map(([group, its]) => {
        const kind = doc.modules[group]?.kind ?? doc.modules[`${scope ? `${scope}/` : ''}${group}`]?.kind;
        return (
          <section key={group} className="knob-group">
            <h3 style={{ color: kind ? KIND_ACCENT[kind] : group === 'Macros' ? 'var(--macro)' : undefined }}>{group}</h3>
            <div className="knob-row">
              {its.map((it) => (
                <ItemKnob key={it.key} it={it} scope={scope} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

/** Route amounts as small bipolar knobs (dragging through 0 doesn't delete the route; × does). */
function Routes({ routes, labelFor }: { routes: { source: string; target: string; amount: number }[]; labelFor: (r: { source: string; target: string }) => string }) {
  const rt = app.runtime;
  if (!routes.length) return null;
  return (
    <section className="knob-group">
      <h3 style={{ color: 'var(--macro)' }}>modulation</h3>
      <div className="knob-row">
        {routes.map((r) => (
          <div key={`${r.source}>${r.target}`} className="route-knob">
            <Knob
              label={labelFor(r)}
              value={r.amount}
              defaultValue={0.25}
              spec={{ min: -1, max: 1, warp: 'lin' }}
              size={44}
              accent="var(--macro)"
              title={`${r.source} → ${r.target} × ${r.amount}`}
              onChange={(v) => rt.modulate(r.source, r.target, Math.abs(v) < 0.001 ? (v < 0 ? -0.001 : 0.001) : v)}
            />
            <button
              className="ghost tiny"
              title="remove this route"
              onClick={() => {
                rt.checkpoint();
                rt.modulate(r.source, r.target, 0);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

const shortRef = (ref: string) => (ref.startsWith('macro:') ? `◆${leafOf(ref.slice(6))}` : leafOf(ref));

function SelectedSection({ id, scope }: { id: string; scope: string }) {
  const rt = app.runtime;
  const doc = rt.doc;
  const [showInside, setShowInside] = useState(false);
  if (id.startsWith('macro:')) {
    const name = id.slice(6);
    const m = doc.macros[name];
    if (!m) return null;
    const routes = doc.mods.filter((r) => r.source === id);
    return (
      <>
        <Groups items={[{ key: id, target: { macro: name }, label: m.label ?? leafOf(name), group: leafOf(name) }]} scope={scope} />
        <Routes routes={routes} labelFor={(r) => shortRef(r.target)} />
      </>
    );
  }
  if (doc.modules[id]) {
    const items = moduleItems(id, leafOf(id));
    const routes = doc.mods.filter((r) => r.target.startsWith(`${id}.`));
    const plays = (rt.module(id)?.compiled.samples.length ?? 0) > 0;
    return (
      <>
        {plays && <LoopView module={id} />}
        {items.length ? <Groups items={items} scope={scope} /> : <p className="dim pad">{leafOf(id)} has no knobs.</p>}
        <Routes routes={routes} labelFor={(r) => `${shortRef(r.source)}→${r.target.slice(r.target.lastIndexOf('.') + 1)}`} />
      </>
    );
  }
  if (doc.subpatches[id]) {
    const f = face(id, `${leafOf(id)} · face`);
    const all = inside(id, scope);
    const open = showInside || !f.length;
    return (
      <>
        {f.length > 0 && <Groups items={f} scope={scope} />}
        {f.length > 0 && (
          <button className="ghost small inside-toggle" onClick={() => setShowInside(!showInside)}>
            {open ? '▾' : '▸'} inside ({all.length})
          </button>
        )}
        {open && (all.length ? <Groups items={all} scope={scope} /> : <p className="dim pad">Nothing inside {leafOf(id)} has knobs yet.</p>)}
      </>
    );
  }
  return null;
}

export function Panels() {
  useEmitter(app.patchEvents);
  useEmitter(app.uiEvents);
  const scope = app.scope;
  const sel = app.selection.filter((id) => !id.includes(':') || id.startsWith('macro:'));
  const tab = app.panel === 'selected' ? (sel.length ? 'selected' : 'performance') : app.panel;
  const sampleCount = Object.keys(app.runtime.doc.samples).length;
  const stripCount = mixChannels(app.runtime).length;
  const takeCount = app.recorder.takes.length;
  const where = scope ? leafOf(scope) : 'patch';
  const selLabel = sel.length === 1 ? leafOf(sel[0].replace(/^macro:/, '')) : `${sel.length}`;
  const perf = tab === 'performance' ? performance(scope) : null;
  const hint =
    tab === 'samples'
      ? 'drop audio files anywhere on the page to add them'
      : tab === 'mixer'
      ? 'your final mix: the agent leaves it to you'
      : tab === 'recordings'
      ? '● REC ⌥R from the next bar · ⟲ ⌥C the last minutes'
      : tab === 'selected'
      ? '☆ puts a knob on this level’s Performance Panel'
      : perf!.curated
        ? scope
          ? `${where}’s face — what it shows from outside`
          : 'your panel — ☆ adds and removes knobs'
        : 'everything here, until you ☆ the knobs you want';

  return (
    <div className="panels">
      <div className="panel-tabs">
        <button className={`tab${tab === 'performance' ? ' on' : ''}`} onClick={() => app.showPanel('performance')}>
          Performance <span className="dim">· {where}</span>
        </button>
        <button className={`tab${tab === 'selected' ? ' on' : ''}`} disabled={!sel.length} onClick={() => app.showPanel('selected')}>
          Selected{sel.length ? <span className="dim"> · {selLabel}</span> : null}
        </button>
        <button className={`tab${tab === 'mixer' ? ' on' : ''}`} onClick={() => app.showPanel('mixer')}>
          Mixer{stripCount ? <span className="dim"> · {stripCount}</span> : null}
        </button>
        <button className={`tab${tab === 'samples' ? ' on' : ''}`} onClick={() => app.showPanel('samples')}>
          Samples{sampleCount ? <span className="dim"> · {sampleCount}</span> : null}
        </button>
        <button className={`tab${tab === 'recordings' ? ' on' : ''}`} onClick={() => app.showPanel('recordings')}>
          Recordings{takeCount ? <span className="dim"> · {takeCount}</span> : null}
        </button>
        <span className="panel-hint dim">{hint}</span>
      </div>
      {tab === 'samples' ? (
        <SamplesPanel />
      ) : tab === 'mixer' ? (
        <MixerPanel />
      ) : tab === 'recordings' ? (
        <RecordingsPanel />
      ) : tab === 'performance' ? (
        perf!.items.length ? (
          <div className="surface">
            <Groups items={perf!.items} scope={scope} />
          </div>
        ) : (
          <div className="surface empty">Knobs appear here as the patch takes shape.</div>
        )
      ) : (
        <div className="surface">
          {sel.map((id) => (
            <SelectedSection key={id} id={id} scope={scope} />
          ))}
        </div>
      )}
    </div>
  );
}
