// The Mixer tab: a strip for every module that plays into the master — its
// fader (the module's level into the mix: the person's, not a knob or a
// modulation target), pan, mute and solo, with a post-fader meter — then the
// master's. Strips come and go with the modules that play.

import { useEffect, useRef, useState } from 'react';
import { app, useEmitter } from '../app/store';
import { faderDb, faderPos, formatDb, mixChannels, toDb, toGain, type MixChannel } from '../app/mix';
import type { ModuleKind } from '../runtime/module-def';
import { leafOf, parentOf } from '../runtime/patch';

const ACCENT: Record<ModuleKind, string> = { audio: 'var(--audio)', control: 'var(--control)', voice: 'var(--voice)' };
/** The fader's travel, in px (the cap is 12 px tall). */
const TRAVEL = 132;
const TICKS = [6, 0, -6, -12, -24, -40, -60];

const at = (pos: number) => 6 + pos * TRAVEL;

/** dB marks, as a strip of their own so its rows line up with the others'. */
function Scale() {
  return (
    <div className="strip scale">
      <div className="strip-name" />
      <div className="pan-row" />
      <div className="mixer-scale" style={{ height: TRAVEL + 12 }}>
        {TICKS.map((db) => (
          <span key={db} style={{ bottom: at(faderPos(db)) - 6 }}>
            {db > 0 ? `+${db}` : db}
          </span>
        ))}
      </div>
      <div className="db" />
      <div className="strip-buttons" />
    </div>
  );
}

/** A vertical fader: drag (shift for fine), wheel, arrows; double-click for 0 dB. */
function Fader({ gain, label, onChange, onCommit }: { gain: number; label: string; onChange: (gain: number) => void; onCommit: () => void }) {
  const pos = faderPos(toDb(gain));
  const drag = useRef<{ y: number; pos: number; moved: boolean } | null>(null);
  const set = (p: number) => onChange(toGain(faderDb(Math.min(1, Math.max(0, p)))));
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef({ pos, set, onCommit });
  live.current = { pos, set, onCommit };
  useEffect(() => {
    // React's wheel listeners are passive; a native one can stop the panel scrolling.
    const el = ref.current;
    if (!el) return;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = live.current;
      s.set(s.pos - e.deltaY / (e.shiftKey ? 4000 : 1000));
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => live.current.onCommit(), 500);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const end = () => {
    if (drag.current?.moved) onCommit();
    drag.current = null;
  };
  return (
    <div
      ref={ref}
      className="fader"
      style={{ height: TRAVEL + 12 }}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuetext={`${formatDb(toDb(gain))} dB`}
      title={`${label}: ${formatDb(toDb(gain))} dB — drag (shift: fine), double-click for 0 dB`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, pos, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.moved = true;
        set(d.pos + (d.y - e.clientY) / (e.shiftKey ? TRAVEL * 5 : TRAVEL));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => {
        onChange(1);
        onCommit();
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.002 : 0.012;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          set(pos + (e.key === 'ArrowUp' ? step : -step));
        }
      }}
      onKeyUp={(e) => (e.key === 'ArrowUp' || e.key === 'ArrowDown') && onCommit()}
    >
      <div className="fader-track" />
      {TICKS.map((db) => (
        <div key={db} className={`fader-tick${db === 0 ? ' zero' : ''}`} style={{ bottom: at(faderPos(db)) }} />
      ))}
      <div className="fader-cap" style={{ bottom: at(pos) - 6 }} />
    </div>
  );
}

/** Peak meter on the fader's scale, with a peak hold. `read` gives linear peaks per bar, or null when stale. */
function Meter({ count, read }: { count: number; read: () => number[] | null }) {
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const holds = useRef<(HTMLDivElement | null)[]>([]);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let raf = 0;
    const held = Array.from({ length: count }, () => ({ v: 0, t: 0 }));
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const vals = readRef.current();
      const now = performance.now();
      for (let i = 0; i < count; i++) {
        const v = vals?.[i] ?? 0;
        const db = toDb(v);
        const bar = bars.current[i];
        if (bar) {
          bar.style.height = `${faderPos(db) * TRAVEL}px`;
          bar.className = db > -1 ? 'meter-bar hot' : db > -9 ? 'meter-bar warm' : 'meter-bar';
        }
        if (v >= held[i].v || now - held[i].t > 1500) held[i] = { v, t: now };
        const hold = holds.current[i];
        if (hold) {
          hold.style.bottom = `${6 + faderPos(toDb(held[i].v)) * TRAVEL}px`;
          hold.style.opacity = held[i].v > 0.001 ? '1' : '0';
          hold.className = toDb(held[i].v) > -1 ? 'meter-hold hot' : 'meter-hold';
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [count]);
  return (
    <div className="meter" style={{ height: TRAVEL + 12 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="meter-lane">
          <div ref={(el) => { bars.current[i] = el; }} className="meter-bar" />
          <div ref={(el) => { holds.current[i] = el; }} className="meter-hold" />
        </div>
      ))}
    </div>
  );
}

const formatPan = (v: number) => (Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`);

/** Pan: drag sideways; double-click for the centre. */
function Pan({ value, onChange, onCommit }: { value: number; onChange: (v: number) => void; onCommit: () => void }) {
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const end = () => {
    if (drag.current?.moved) onCommit();
    drag.current = null;
  };
  return (
    <div className="pan-row" title={`pan ${formatPan(value)} — drag sideways, double-click to centre`}>
      <div
        className="pan"
        role="slider"
        aria-label="pan"
        aria-valuenow={value}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, v: value, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          d.moved = true;
          const v = Math.max(-1, Math.min(1, d.v + (e.clientX - d.x) / (e.shiftKey ? 300 : 60)));
          onChange(Math.abs(v) < 0.02 ? 0 : v);
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => {
          onChange(0);
          onCommit();
        }}
      >
        <div className="pan-fill" style={{ left: `${50 + Math.min(0, value) * 50}%`, width: `${Math.abs(value) * 50}%` }} />
        <div className="pan-centre" />
      </div>
      <span className="pan-value">{formatPan(value)}</span>
    </div>
  );
}

/** The level in dB; double-click to type one. */
function DbReadout({ gain, onSet }: { gain: number; onSet: (gain: number) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    const commit = (text: string) => {
      setEditing(false);
      const t = text.trim().replace('−', '-').toLowerCase();
      if (/^-?inf/.test(t) || t === '-∞') return onSet(0);
      const db = Number(t.replace(/db$/, ''));
      if (Number.isFinite(db)) onSet(toGain(Math.max(-80, Math.min(12, db))));
    };
    return (
      <input
        className="db-input"
        autoFocus
        defaultValue={formatDb(toDb(gain)).replace('−', '-')}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          else if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <button className="db" title="double-click to type a level in dB" onDoubleClick={() => setEditing(true)}>
      {formatDb(toDb(gain))}
    </button>
  );
}

function Strip({ ch }: { ch: MixChannel }) {
  const rt = app.runtime;
  const d = rt.doc.modules[ch.path];
  if (!d) return null;
  const set = (opts: Parameters<typeof rt.setMonitor>[1]) => rt.setMonitor(ch.path, opts);
  const level = () => formatDb(toDb(rt.doc.modules[ch.path]?.level ?? 0));
  const bars = ch.channels === 2 ? 2 : 1;
  const read = () => {
    const m = app.engine.meters.get(ch.meterId);
    const doc = rt.doc.modules[ch.path];
    if (!m || !doc || performance.now() - m.time > 400 || app.stopped) return null;
    if (rt.silenced(ch.path)) return [0, 0];
    const p = m.peak;
    return bars === 2 ? [p[0] * doc.level, (p[1] ?? p[0]) * doc.level] : [Math.max(0, ...p) * doc.level];
  };
  const solo = (exclusive: boolean) => {
    if (exclusive) {
      for (const [p, x] of Object.entries(rt.doc.modules)) if (x.solo && p !== ch.path) rt.setMonitor(p, { solo: false });
      if (!d.solo) set({ solo: true });
    } else set({ solo: !d.solo });
    app.mixed(`${d.solo ? 'soloed' : 'unsoloed'} ${ch.path}${exclusive ? ' (only it)' : ''}`);
  };
  return (
    <div className={`strip${rt.silenced(ch.path) ? ' silenced' : ''}${app.selection.includes(ch.path) ? ' selected' : ''}`}>
      <button className="strip-name" style={{ color: ACCENT[ch.kind] }} title={`${ch.path} · ${ch.kind}, ${ch.channels}ch — click to select`} onClick={() => app.select(ch.path, { stay: true })}>
        {leafOf(ch.path)}
      </button>
      <Pan value={d.pan} onChange={(v) => set({ pan: v })} onCommit={() => app.mixed(`${ch.path} panned ${formatPan(rt.doc.modules[ch.path]?.pan ?? 0)}`)} />
      <div className="strip-body">
        <Meter count={bars} read={read} />
        <Fader gain={d.level} label={leafOf(ch.path)} onChange={(g) => set({ level: g })} onCommit={() => app.mixed(`${ch.path} at ${level()} dB`)} />
      </div>
      <DbReadout
        gain={d.level}
        onSet={(g) => {
          set({ level: g });
          app.mixed(`${ch.path} at ${level()} dB`);
        }}
      />
      <div className="strip-buttons">
        <button
          className={`ms mute${d.mute ? ' on' : ''}`}
          title="mute"
          onClick={() => {
            set({ mute: !d.mute });
            app.mixed(`${d.mute ? 'muted' : 'unmuted'} ${ch.path}`);
          }}
        >
          M
        </button>
        <button className={`ms solo${d.solo ? ' on' : ''}`} title="solo (⌥-click: solo only this)" onClick={(e) => solo(e.altKey || e.metaKey)}>
          S
        </button>
      </div>
    </div>
  );
}

function MasterStrip() {
  const rt = app.runtime;
  const level = () => formatDb(toDb(rt.doc.master.level));
  return (
    <div className="strip master">
      <div className="strip-name" title="everything, after the master's limiter: what you hear, and what ● REC records">master</div>
      <div className="pan-row" />
      <div className="strip-body">
        <Meter
          count={2}
          read={() => {
            const m = app.engine.masterMeter;
            return performance.now() - m.time < 400 && !app.stopped ? m.peak : null;
          }}
        />
        <Fader gain={rt.doc.master.level} label="master" onChange={(g) => rt.setMasterLevel(g)} onCommit={() => app.mixed(`master at ${level()} dB`)} />
      </div>
      <DbReadout
        gain={rt.doc.master.level}
        onSet={(g) => {
          rt.setMasterLevel(g);
          app.mixed(`master at ${level()} dB`);
        }}
      />
      <div className="strip-buttons" />
    </div>
  );
}

export function MixerPanel() {
  useEmitter(app.patchEvents);
  useEmitter(app.uiEvents);
  const channels = mixChannels(app.runtime);
  // Grouped by the subpatch they live in, the top level first.
  const groups = new Map<string, MixChannel[]>();
  for (const c of channels) groups.set(parentOf(c.path), [...(groups.get(parentOf(c.path)) ?? []), c]);
  const ordered = [...groups.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : 0));
  const labelled = ordered.some(([g]) => g);
  return (
    <div className="mixer">
      <div className="mixer-strips">
        <Scale />
        {channels.length === 0 && <div className="mixer-empty dim">Every module that plays into the master gets a strip here as it appears.</div>}
        {ordered.map(([g, cs]) => (
          <div key={g || '/'} className="mixer-group">
            {labelled && (
              <div className="mixer-group-name" title={g || 'the top level'}>
                {g ? leafOf(g) : 'patch'}
              </div>
            )}
            <div className="mixer-group-strips">
              {cs.map((c) => (
                <Strip key={c.path} ch={c} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className={`mixer-master${labelled ? ' labelled' : ''}`}>
        <MasterStrip />
      </div>
    </div>
  );
}
