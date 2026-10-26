import { useEffect, useRef, useState } from 'react';
import { app, useEmitter } from '../app/store';
import { AgentChat } from './AgentChat';
import { Inspector } from './Inspector';
import { PatchMenu } from './PatchMenu';
import { Panels } from './Panels';
import { PatchGraph } from './PatchGraph';

function MasterMeter() {
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const m = app.engine.masterMeter;
      const fresh = performance.now() - m.time < 400;
      [0, 1].forEach((c) => {
        const el = bars.current[c];
        if (!el) return;
        const p = fresh ? m.peak[c] ?? 0 : 0;
        const db = p > 0 ? 20 * Math.log10(p) : -90;
        el.style.width = `${Math.max(0, Math.min(1, (db + 60) / 60)) * 100}%`;
        el.className = db > -1 ? 'bar hot' : db > -9 ? 'bar warm' : 'bar';
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="master-meter" title="master peak">
      <div className="lane"><div ref={(el) => { bars.current[0] = el; }} className="bar" /></div>
      <div className="lane"><div ref={(el) => { bars.current[1] = el; }} className="bar" /></div>
    </div>
  );
}

function Transport() {
  useEmitter(app.patchEvents);
  const [bpm, setBpm] = useState(String(app.runtime.doc.bpm));
  useEffect(() => setBpm(String(Math.round(app.seq.bpm * 100) / 100)), [app.runtime.doc.bpm]);
  useEmitter(app.uiEvents);
  const routines = app.seq.list();
  return (
    <div className="transport">
      <button
        className={`transport-button${app.stopped ? ' stopped' : ''}`}
        onClick={() => app.toggleTransport()}
        title={app.stopped ? 'play: pick up where it stopped (⌘.)' : 'stop the sound, the routines and the agent (⌘.)'}
      >
        {app.stopped ? '▶' : '■'}
      </button>
      <label>
        <input
          className="bpm"
          value={bpm}
          onChange={(e) => setBpm(e.target.value)}
          onBlur={() => {
            const v = Number(bpm);
            if (v >= 10 && v <= 999) app.seq.setBpm(v);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="dim">bpm</span>
      </label>
      {routines.map((r) => (
        <button
          key={r.name}
          className={`chip${r.playing ? ' on' : ''}${r.error ? ' err' : ''}`}
          title={r.error ?? (r.playing ? 'playing — click to stop' : 'stopped — click to play')}
          onClick={() => (r.playing ? app.seq.stop(r.name) : app.seq.play(r.name))}
        >
          {r.playing ? '■' : '▶'} {r.name}
        </button>
      ))}
    </div>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  useEmitter(app.uiEvents);
  const s = app.settings;
  return (
    <div className="settings">
      <h3>Settings</h3>
      <p className="dim">Agent: DeepSeek V4.1 Flash on Workers AI, through AI Gateway.</p>
      <label>
        Reasoning
        <select value={s.effort} onChange={(e) => app.updateSettings({ effort: e.target.value as typeof s.effort })}>
          <option value="off">off: fastest</option>
          <option value="low">low</option>
          <option value="high">high: complex patches</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.autoSendVoice} onChange={(e) => app.updateSettings({ autoSendVoice: e.target.checked })} />
        send voice input when I let go
      </label>
      <div className="row between">
        <div className="row">
          <button className="ghost" onClick={() => app.clearConversation()}>clear conversation</button>
          <button
            className="ghost"
            onClick={() => {
              onClose();
              app.showDialog('new');
            }}
          >
            new session
          </button>
        </div>
        <button onClick={onClose}>done</button>
      </div>
    </div>
  );
}

function Log() {
  useEmitter(app.logEvents);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
  return (
    <div className="log" ref={ref}>
      {app.engine.log.slice(-120).map((e, i) => (
        <div key={i} className={`log-${e.kind}`}>{e.text}</div>
      ))}
    </div>
  );
}

/** ⌘. stops and plays (SuperCollider's own), ⌘S saves, ⌘O opens — from anywhere. */
function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '.') {
        e.preventDefault();
        app.toggleTransport();
      } else if (e.key.toLowerCase() === 's' && !e.shiftKey) {
        e.preventDefault();
        if (app.state === 'ready') void app.save().catch((err) => app.engine.info(`save failed: ${(err as Error).message}`));
      } else if (e.key.toLowerCase() === 'o') {
        e.preventDefault();
        if (app.state === 'ready') app.showDialog('open');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function StartScreen() {
  useEmitter(app.uiEvents);
  const waiting = app.waitingTools;
  if (app.state === 'ready') return null;
  return (
    <div className="boot">
      {app.state === 'error' ? (
        <>
          <p className="error">The engine failed to start: {app.bootError}</p>
          <button onClick={() => void app.start()}>retry</button>
        </>
      ) : (
        <>
          <button className="big" disabled={app.state !== 'off'} onClick={() => void app.start()}>
            {app.state === 'booting' ? 'starting scsynth…' : app.state === 'restoring' ? 'bringing your patch back…' : 'start audio'}
          </button>
          {app.resumes && app.state === 'off' && (
            <p>
              Picks up “{app.resumes.title}” ({app.resumes.modules} module{app.resumes.modules === 1 ? '' : 's'}) where you left it.
            </p>
          )}
          <p className="dim">SuperCollider's scsynth runs in this page (WebAssembly in an AudioWorklet). Browsers need a click before they make sound.</p>
        </>
      )}
      {waiting > 0 && (
        <div className="waiting">
          <p>
            The agent was in the middle of something: {waiting} action{waiting === 1 ? '' : 's'} will run once audio starts and your patch is back.
          </p>
          <button className="ghost danger" onClick={() => app.stopAgent()}>
            don't run {waiting === 1 ? 'it' : 'them'}
          </button>
        </div>
      )}
    </div>
  );
}

export function App() {
  useEmitter(app.uiEvents);
  useEmitter(app.patchEvents);
  useGlobalKeys();
  const [showSettings, setShowSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const rt = app.runtime;

  return (
    <div className={`app${app.stopped ? ' is-stopped' : ''}`}>
      <header className="top">
        <div className="brand-row">
          <span className="brand">patter</span>
          <PatchMenu />
        </div>
        {app.state === 'ready' ? <Transport /> : <div />}
        <div className="row">
          <MasterMeter />
          <button className="ghost" disabled={!rt.canUndo} onClick={() => void rt.undo()} title="undo (⌘Z)">↶</button>
          <button className="ghost" disabled={!rt.canRedo} onClick={() => void rt.redo()} title="redo (⌘⇧Z)">↷</button>
          <button className="ghost" onClick={() => setShowLog(!showLog)}>log</button>
          <button className="ghost" onClick={() => setShowSettings(!showSettings)}>settings</button>
        </div>
      </header>

      <StartScreen />

      <main className="main">
        <aside className="left">
          <AgentChat key={app.session} />
        </aside>
        <section className="center">
          <div className="graph-wrap">
            <PatchGraph />
          </div>
          <div className="surface-wrap">
            <Panels />
          </div>
        </section>
        <aside className="right">
          <Inspector />
          {rt.doc.notes && <div className="notes"><h3>Notes</h3><p>{rt.doc.notes}</p></div>}
        </aside>
      </main>
      {showLog && <Log />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
