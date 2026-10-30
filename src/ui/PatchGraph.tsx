// The patch as a picture, one level at a time, like a Pd/Max patcher window:
// the scope's children as boxes (a subpatch is a double-bordered box with its
// inlets and outlets as ports), the scope's own inlets down the left and its
// outlets down the right, control above audio, signal flowing left to right.
// Click selects (shift adds), dragging on the background selects a region,
// double-clicking a subpatch opens it; the bar above shows where you are.

import { useEffect, useRef, useState } from 'react';
import { app, useEmitter } from '../app/store';
import { levelGraph, type LevelEdge, type LevelNode } from '../runtime/graph';
import { leafOf, parentOf, SEGMENT } from '../runtime/patch';
import { instanceRootOf } from '../runtime/resolve';

const W = 140;
const H = 44;
const SUB_W = 158;
const PORT_W = 112;
const PORT_H = 38;
const COL = 178;
const VGAP = 16;
const BAND_GAP = 38;
const PORT_TOP = 33;
const PORT_STEP = 14;
const clip = (s: string, n = 10) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Box extends LevelNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

function sizeOf(n: LevelNode): [number, number] {
  if (n.kind === 'subpatch') return [SUB_W, Math.max(H + 4, PORT_TOP + PORT_STEP * Math.max(n.inlets!.length, n.outlets!.length, 1) - 2)];
  if (n.kind === 'inlet' || n.kind === 'outlet' || n.kind === 'external') return [PORT_W, PORT_H];
  return [W, H];
}

function layout(scope: string): { boxes: Box[]; edges: LevelEdge[]; width: number; height: number } {
  const { nodes, edges } = levelGraph(app.runtime, scope);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const signal = edges.filter((e) => e.kind !== 'mod');
  const preds = new Map<string, string[]>();
  for (const e of signal) preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);

  // Columns: longest path from the sources; the scope's ports at the edges.
  const sources = (n: LevelNode) => n.kind === 'inlet' || n.kind === 'external';
  const base = nodes.some(sources) ? 1 : 0;
  const col = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (col.has(id)) return col.get(id)!;
    const n = byId.get(id)!;
    if (sources(n)) return col.set(id, 0), 0;
    if (visiting.has(id)) return base; // a feedback loop
    visiting.add(id);
    let best = base;
    for (const p of preds.get(id) ?? []) {
      const pn = byId.get(p);
      if (pn && pn.kind !== 'outlet' && pn.kind !== 'macro') best = Math.max(best, depth(p) + 1);
    }
    visiting.delete(id);
    col.set(id, best);
    return best;
  };
  const inner = nodes.filter((n) => n.kind !== 'macro' && n.kind !== 'outlet');
  for (const n of inner) depth(n.id);
  const last = Math.max(base, ...inner.map((n) => col.get(n.id) ?? 0)) + 1;
  for (const n of nodes) if (n.kind === 'outlet') col.set(n.id, last);

  const boxes: Box[] = [];
  const place = (n: LevelNode, x: number, y: number) => {
    const [w, h] = sizeOf(n);
    const b = { ...n, x, y, w, h };
    boxes.push(b);
    return b;
  };
  let top = 14;
  const macros = nodes.filter((n) => n.kind === 'macro');
  macros.forEach((n, i) => place(n, 16 + i * (W + 20), top));
  if (macros.length) top += H + BAND_GAP;

  // Bands: control above audio. Within a column, order by where the inputs come from.
  const yIndex = new Map<string, number>();
  for (const band of ['control', 'audio'] as const) {
    const members = nodes.filter((n) => n.kind !== 'macro' && n.rate === band);
    if (!members.length) continue;
    const cols = new Map<number, LevelNode[]>();
    for (const n of members) {
      const c = col.get(n.id) ?? 0;
      cols.set(c, [...(cols.get(c) ?? []), n]);
    }
    let bandHeight = 0;
    for (const c of [...cols.keys()].sort((a, b) => a - b)) {
      const list = cols.get(c)!;
      const key = (n: LevelNode) => {
        const ys = (preds.get(n.id) ?? []).map((p) => yIndex.get(p)).filter((y): y is number => y !== undefined);
        return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : list.indexOf(n) + 0.5;
      };
      list.sort((a, b) => key(a) - key(b));
      let y = top;
      list.forEach((n, i) => {
        const b = place(n, 16 + c * COL, y);
        yIndex.set(n.id, i);
        y += b.h + VGAP;
      });
      bandHeight = Math.max(bandHeight, y - top);
    }
    top += bandHeight + BAND_GAP - VGAP;
  }
  const width = Math.max(...boxes.map((b) => b.x + b.w), 320) + 24;
  const height = Math.max(top, 140) + 10;
  return { boxes, edges, width, height };
}

function portY(b: Box, i: number) {
  return b.y + PORT_TOP + PORT_STEP * i - 3;
}

function outAnchor(b: Box, port?: string): [number, number] {
  const i = port && b.outlets ? b.outlets.indexOf(port) : -1;
  return [b.x + b.w, i >= 0 ? portY(b, i) : b.y + b.h / 2];
}

function inAnchor(b: Box, port?: string): [number, number] {
  const i = port && b.inlets ? b.inlets.indexOf(port) : -1;
  return [b.x, i >= 0 ? portY(b, i) : b.y + b.h / 2];
}

function cable(a: Box, b: Box, e: LevelEdge): string {
  if (e.kind === 'mod') {
    // CV into the top of the box, like a cable into a knob.
    const [x1, y1] = [a.x + a.w, a.y + a.h / 2 + 6];
    const [x2, y2] = [b.x + b.w / 2, b.y];
    if (y2 > y1 + 10) return `M ${x1} ${y1} C ${x1 + 50} ${y1}, ${x2} ${y2 - 50}, ${x2} ${y2}`;
    const high = Math.min(a.y, b.y) - 18;
    return `M ${x1} ${y1} C ${x1 + 50} ${y1}, ${x1 + 50} ${high}, ${(x1 + x2) / 2} ${high} S ${x2} ${y2 - 30}, ${x2} ${y2}`;
  }
  const [x1, y1] = outAnchor(a, e.fromPort);
  const [x2, y2] = inAnchor(b, e.toPort);
  if (x2 > x1 + 12) {
    const dx = Math.max(36, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  // Backwards (feedback): loop underneath.
  const low = Math.max(a.y + a.h, b.y + b.h) + 22;
  return `M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x1 + 60} ${low}, ${(x1 + x2) / 2} ${low} S ${x2 - 60} ${y2}, ${x2} ${y2}`;
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

/** Graph-node ids that can be grouped (modules and subpatches, not ports or macros). */
const groupable = (id: string) => !id.includes(':');

// ── the bar: where you are, and what you can do with the selection ─────────

function GraphBar({ naming, setNaming }: { naming: boolean; setNaming: (v: boolean) => void }) {
  useEmitter(app.uiEvents);
  useEmitter(app.patchEvents);
  const rt = app.runtime;
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const crumbs = [''];
  if (app.scope) app.scope.split('/').forEach((_, i, a) => crumbs.push(a.slice(0, i + 1).join('/')));
  const sel = app.selection.filter(groupable);
  const one = app.selected;
  const isSub = one ? Boolean(rt.doc.subpatches[one]) : false;
  const isModule = one ? Boolean(rt.doc.modules[one]) : false;

  useEffect(() => {
    if (naming) {
      setName('');
      setError(null);
    }
  }, [naming]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      rt.checkpoint();
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const group = () =>
    run(async () => {
      const n = name.trim();
      if (!SEGMENT.test(n)) throw new Error('a lowercase name: a-z, 0-9, _');
      const r = await rt.groupIntoSubpatch(app.scope, n, sel.map(leafOf));
      setNaming(false);
      app.select(r.path);
    });

  return (
    <div className="graph-bar">
      <nav className="crumbs">
        {crumbs.map((c, i) => {
          const abs = c ? rt.doc.subpatches[c]?.abstraction : undefined;
          return (
            <span key={c} className="crumb-wrap">
              {i > 0 && <span className="crumb-sep">›</span>}
              <button className={`crumb${c === app.scope ? ' here' : ''}`} onClick={() => app.enter(c)} title={c ? rt.doc.subpatches[c]?.description : 'the top level'}>
                {c ? leafOf(c) : 'patch'}
                {abs && <span className="crumb-abs">{abs}</span>}
              </button>
            </span>
          );
        })}
      </nav>
      <div className="graph-actions">
        {error && <span className="error small">{error}</span>}
        {naming ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void group();
            }}
          >
            <span className="dim">group {sel.length} as</span>
            <input
              autoFocus
              className="name-input"
              value={name}
              placeholder="voice"
              onChange={(e) => setName(e.target.value.toLowerCase())}
              onKeyDown={(e) => e.key === 'Escape' && setNaming(false)}
            />
            <button type="submit" disabled={!name.trim()}>group</button>
            <button type="button" className="ghost" onClick={() => setNaming(false)}>cancel</button>
          </form>
        ) : (
          <>
            {sel.length > 0 && !app.listening && (
              <button className="ghost" title="move the selection into a new subpatch (⌘G)" onClick={() => setNaming(true)}>
                group{sel.length > 1 ? ` ${sel.length}` : ''}
              </button>
            )}
            {isSub && (
              <>
                <button className="ghost" title="open (↵ or double-click)" onClick={() => app.enter(one!)}>open</button>
                {!app.listening && (
                  <button className="ghost" title="dissolve into this level (⌘⇧G)" onClick={() => void run(async () => app.selectMany((await rt.ungroup(one!)).moved))}>ungroup</button>
                )}
              </>
            )}
            {(isSub || isModule) && !app.listening && (
              <button className="ghost" title="duplicate (⌘D)" onClick={() => void run(async () => app.select((await rt.duplicate(one!)).path))}>duplicate</button>
            )}
            {app.scope && sel.length === 0 && (
              <button className="ghost" title="up a level (esc)" onClick={() => app.up()}>↑ up</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── the graph ───────────────────────────────────────────────────────────────

export function PatchGraph() {
  useEmitter(app.patchEvents);
  useEmitter(app.uiEvents);
  const [naming, setNaming] = useState(false);
  const { boxes, edges, width, height } = layout(app.scope);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const meterRefs = useRef(new Map<string, { rect: SVGRectElement; module: string; w: number }>());
  const svgRef = useRef<SVGSVGElement>(null);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number; add: boolean } | null>(null);

  // Meters: every module's bus is measured (by its monitor, or a meter synth).
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 60 || !app.engine.booted) return;
      last = t;
      for (const { rect, module, w } of meterRefs.current.values()) {
        const m = app.runtime.module(module);
        if (!m) continue;
        const meter = app.engine.meters.get(m.meterId);
        const level = meter && performance.now() - meter.time < 500 ? Math.max(...meter.peak, 0) : 0;
        if (m.compiled.shape.rate === 'control') {
          // CV: 0..1 across the bar (values in Hz just fill it).
          rect.setAttribute('width', String(Math.min(1, level) * w));
          rect.setAttribute('class', 'meter cv');
          continue;
        }
        const db = level > 0 ? 20 * Math.log10(level) : -90;
        rect.setAttribute('width', String(Math.max(0, Math.min(1, (db + 60) / 60)) * w));
        rect.setAttribute('class', db > -1 ? 'meter hot' : 'meter');
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keys: esc out, ↵ in, ⌘G group, ⌘⇧G ungroup, ⌘D duplicate, ⌘A all, ⌘Z undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || app.dialog || app.state !== 'ready') return;
      const rt = app.runtime;
      const mod = e.metaKey || e.ctrlKey;
      const one = app.selected;
      const attempt = (fn: () => Promise<unknown>) => {
        rt.checkpoint();
        fn().catch((err) => app.engine.info(`can't: ${(err as Error).message}`));
      };
      if (e.key === 'Escape') {
        if (app.selection.length) app.select(null);
        else app.up();
      } else if (e.key === 'Enter' && one && rt.doc.subpatches[one]) {
        app.enter(one);
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        app.selectMany(boxes.filter((b) => groupable(b.id)).map((b) => b.id));
      } else if (app.listening) {
        // A listener looks around; the patch's structure is the host's.
        return;
      } else if (mod && e.key.toLowerCase() === 'g' && !e.shiftKey && app.selection.some(groupable)) {
        e.preventDefault();
        setNaming(true);
      } else if (mod && e.key.toLowerCase() === 'g' && e.shiftKey && one && rt.doc.subpatches[one]) {
        e.preventDefault();
        attempt(async () => app.selectMany((await rt.ungroup(one)).moved));
      } else if (mod && e.key.toLowerCase() === 'd' && one && (rt.doc.subpatches[one] || rt.doc.modules[one])) {
        e.preventDefault();
        attempt(async () => app.select((await rt.duplicate(one)).path));
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void (e.shiftKey ? rt.redo() : rt.undo());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const point = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target as Element).classList.contains('graph-bg')) return;
    const [x, y] = point(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setBand({ x0: x, y0: y, x1: x, y1: y, add: e.shiftKey || e.metaKey });
  };
  const onBackgroundMove = (e: React.PointerEvent) => {
    if (!band) return;
    const [x, y] = point(e);
    setBand({ ...band, x1: x, y1: y });
  };
  const onBackgroundUp = () => {
    if (!band) return;
    const [lx, hx] = [Math.min(band.x0, band.x1), Math.max(band.x0, band.x1)];
    const [ly, hy] = [Math.min(band.y0, band.y1), Math.max(band.y0, band.y1)];
    setBand(null);
    if (hx - lx < 4 && hy - ly < 4) {
      if (!band.add) app.select(null);
      return;
    }
    const hit = boxes.filter((b) => groupable(b.id) && b.x < hx && b.x + b.w > lx && b.y < hy && b.y + b.h > ly).map((b) => b.id);
    app.selectMany(band.add ? [...app.selection, ...hit] : hit);
  };

  const onNodeClick = (e: React.MouseEvent, b: Box) => {
    e.stopPropagation();
    if (b.kind === 'inlet' || b.kind === 'outlet') return app.select(null); // the scope itself
    if (b.kind === 'external') return;
    app.select(b.id, { add: e.shiftKey || e.metaKey });
  };
  const onNodeDouble = (b: Box) => {
    if (b.kind === 'subpatch') app.enter(b.id);
    else if (b.kind === 'inlet') app.up();
    else if (b.kind === 'external' && !b.id.startsWith('ext:macro:')) {
      const target = b.id.slice(4);
      app.enter(parentOf(target));
      app.select(target);
    }
  };

  const doc = app.runtime.doc;
  const empty = boxes.length === 0;
  // The abstraction instance we're inside, if any (the scope itself or one around it).
  const inst = app.scope ? (doc.subpatches[app.scope]?.abstraction ? app.scope : instanceRootOf(doc, app.scope)) : '';
  const others = inst ? app.runtime.instancesOf(doc.subpatches[inst].abstraction!).length - 1 : 0;

  return (
    <div className="graph-pane">
      <GraphBar naming={naming} setNaming={setNaming} />
      {empty && !app.scope ? (
        <div className="graph empty">
          {app.listening ? (
            <div>
              <p>Nothing in the patch yet.</p>
              <p className="dim">It fills in here as it's built: modules, cables, macros, all of it running in this page.</p>
            </div>
          ) : (
            <div>
              <p>Describe a patch — by voice or text.</p>
              <p className="dim">“Two detuned saws into a resonant low-pass, a slow sine LFO on the cutoff, an envelope on a VCA, clocked by a 16th-note sequencer in C minor.”</p>
            </div>
          )}
        </div>
      ) : empty ? (
        <div className="graph empty">
          <div>
            <p>This subpatch is empty.</p>
            <p className="dim">{app.listening ? 'Go up (esc).' : `Ask for something to be built in “${leafOf(app.scope)}”, or go up (esc).`}</p>
          </div>
        </div>
      ) : (
        <div className="graph">
          <svg
            ref={svgRef}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            onPointerDown={onBackgroundDown}
            onPointerMove={onBackgroundMove}
            onPointerUp={onBackgroundUp}
          >
            <rect className="graph-bg" x={0} y={0} width={width} height={height} />
            <defs>
              <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--dim)" />
              </marker>
            </defs>
            {edges.map((e, i) => {
              const a = byId.get(e.from);
              const b = byId.get(e.to);
              if (!a || !b) return null;
              const lit = app.selection.includes(e.from) || app.selection.includes(e.to);
              return (
                <g key={i} className={`edge edge-${e.kind}${lit ? ' lit' : ''}`}>
                  <path id={`edge-${i}`} d={cable(a, b, e)} markerEnd="url(#arrow)" />
                  {e.label && (
                    <text dy={-4}>
                      <textPath href={`#edge-${i}`} startOffset="55%" textAnchor="middle">{e.label}</textPath>
                    </text>
                  )}
                </g>
              );
            })}
            {boxes.map((b) => {
              const selected = app.selection.includes(b.id);
              const kindText = b.kind === 'subpatch' ? (b.abstraction ? `${b.abstraction}${(() => { const n = app.runtime.instancesOf(b.abstraction!).length; return n > 1 ? ` ×${n}` : ''; })()}` : 'subpatch') : b.kind === 'external' ? '' : b.kind;
              const meterW = b.w - 16;
              return (
                <g
                  key={b.id}
                  className={`node node-${b.kind}${selected ? ' selected' : ''}${b.abstraction ? ' instance' : ''}`}
                  transform={`translate(${b.x}, ${b.y})`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => onNodeClick(e, b)}
                  onDoubleClick={() => onNodeDouble(b)}
                >
                  <title>{[b.id.startsWith('ext:') ? b.id.slice(4) : b.id, b.kind === 'subpatch' ? b.sub : '', b.description].filter(Boolean).join(' — ')}</title>
                  <rect className="box" width={b.w} height={b.h} rx={b.kind === 'inlet' || b.kind === 'outlet' ? b.h / 2 : 7} />
                  {b.kind === 'subpatch' && <rect className="box-inner" x={3} y={3} width={b.w - 6} height={b.h - 6} rx={5} />}
                  {b.kind === 'inlet' || b.kind === 'outlet' ? (
                    <>
                      <text x={b.kind === 'inlet' ? 14 : b.w - 14} y={15} className="node-name" textAnchor={b.kind === 'inlet' ? 'start' : 'end'}>
                        {b.kind === 'inlet' ? `▸ ${b.label}` : `${b.label} ▸`}
                      </text>
                      <text x={b.kind === 'inlet' ? 14 : b.w - 14} y={27} className="node-sub" textAnchor={b.kind === 'inlet' ? 'start' : 'end'}>{clip(b.sub, 16)}</text>
                    </>
                  ) : b.kind === 'subpatch' ? (
                    <>
                      <text x={11} y={18} className="node-name">{b.label}</text>
                      <text x={b.w - 11} y={18} className="node-kind" textAnchor="end">{kindText}</text>
                      {b.inlets!.map((p, i) => (
                        <g key={`i-${p}`}>
                          <circle cx={0} cy={portY(b, i) - b.y} r={3.5} className="port" />
                          <text x={9} y={portY(b, i) - b.y + 3} className="port-label">{clip(p)}</text>
                        </g>
                      ))}
                      {b.outlets!.map((p, i) => (
                        <g key={`o-${p}`}>
                          <circle cx={b.w} cy={portY(b, i) - b.y} r={3.5} className="port" />
                          <text x={b.w - 9} y={portY(b, i) - b.y + 3} className="port-label" textAnchor="end">{clip(p)}</text>
                        </g>
                      ))}
                    </>
                  ) : (
                    <>
                      <text x={10} y={18} className="node-name">{b.label}</text>
                      <text x={b.w - 10} y={18} className="node-kind" textAnchor="end">{kindText}</text>
                      <text x={10} y={33} className="node-sub">{b.sub}</text>
                    </>
                  )}
                  {b.meter && b.kind !== 'macro' && (
                    <>
                      <rect x={8} y={b.h - 5} width={meterW} height={2} className="meter-bg" />
                      <rect
                        x={8}
                        y={b.h - 5}
                        width={0}
                        height={2}
                        className="meter"
                        ref={(el) => {
                          if (el) meterRefs.current.set(b.id, { rect: el, module: b.meter!, w: meterW });
                          else meterRefs.current.delete(b.id);
                        }}
                      />
                    </>
                  )}
                </g>
              );
            })}
            {band && (
              <rect
                className="rubber-band"
                x={Math.min(band.x0, band.x1)}
                y={Math.min(band.y0, band.y1)}
                width={Math.abs(band.x1 - band.x0)}
                height={Math.abs(band.y1 - band.y0)}
              />
            )}
          </svg>
          {inst && (
            <div className="instance-note">
              Inside <strong>{leafOf(inst)}</strong>, an instance of <strong>{doc.subpatches[inst].abstraction}</strong>: code and structure edits here reach{' '}
              {others} other instance{others === 1 ? '' : 's'}. Knob values stay per instance.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
