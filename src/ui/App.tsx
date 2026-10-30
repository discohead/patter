import { Suspense, useEffect, useRef, useState } from 'react';
import { app, useEmitter } from '../app/store';
import { UNTITLED } from '../app/tree';
import { AgentChat } from './AgentChat';
import { Inspector } from './Inspector';
import { Dialogs } from './Dialogs';
import { Navigator } from './Navigator';
import { FollowSwitch, HOST, NetworkStrip, OnAirTitle, Transcript } from './OnAir';
import { Panels } from './Panels';
import { SessionMenu } from './SessionMenu';
import { PatchGraph } from './PatchGraph';
import { CaptureButton, RecordButton, Toast } from './Takes';

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
      <RecordButton />
      <CaptureButton />
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
      {!app.listening && (
        <>
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
        </>
      )}
      <h4>Recording</h4>
      <label>
        ⟲ capture keeps the last
        <select value={s.captureMinutes} onChange={(e) => app.updateSettings({ captureMinutes: Number(e.target.value) })}>
          {[1, 2, 3, 5, 10, 15, 20].map((m) => (
            <option key={m} value={m}>
              {m} minute{m === 1 ? '' : 's'} (about {Math.round((m * 60 * (app.engine.booted ? app.engine.sampleRate : 48000) * 8) / 1e6)} MB of memory)
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.autoDownload} onChange={(e) => app.updateSettings({ autoDownload: e.target.checked })} />
        download each take as soon as it's done
      </label>
      {!app.listening && (
        <>
          <h4>Sessions</h4>
          <div className="row wrap">
            <button
              className="ghost"
              title="a fresh session with this patch; this one stays in the library"
              onClick={() => {
                onClose();
                void app.freshStart().catch((e) => app.showToast((e as Error).message, { error: true }));
              }}
            >
              clear the conversation
            </button>
            <button
              className="ghost"
              onClick={() => {
                onClose();
                void app.newSession(null);
              }}
            >
              new session
            </button>
            <button
              className="ghost"
              title="what every session reads, wherever it is"
              onClick={() => {
                onClose();
                app.showDialog({ kind: 'context', level: 'person' });
              }}
            >
              your AGENTS.md…
            </button>
          </div>
        </>
      )}
      <div className="row end">
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

/**
 * ⌘. stops and plays (SuperCollider's own), ⌘S keeps a checkpoint, ⌘O finds
 * a session, ⌘\ shows the library, ⌥R (or F9) records the mix, ⌥C captures
 * its last minutes — from anywhere, the chat box too. A listener's page has
 * no library: there, only the sound and the recorder.
 */
function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌥ letters type characters (®, ç) on a Mac: match the key, not the character.
      const plainAlt = e.altKey && !e.metaKey && !e.ctrlKey;
      if ((plainAlt && e.code === 'KeyR') || (e.key === 'F9' && !e.metaKey && !e.ctrlKey && !e.altKey)) {
        e.preventDefault();
        if (!e.repeat) app.toggleRecord();
        return;
      }
      if (plainAlt && e.code === 'KeyC') {
        e.preventDefault();
        if (!e.repeat) void app.capture();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '.') {
        e.preventDefault();
        app.toggleTransport();
      } else if (app.listening) {
        return;
      } else if (e.key.toLowerCase() === 's' && !e.shiftKey) {
        e.preventDefault();
        void app.checkpointNow();
      } else if (e.key.toLowerCase() === 'o') {
        e.preventDefault();
        app.toggleNav(true);
        setTimeout(() => app.focusLibrarySearch(), 0);
      } else if (e.key === '\\') {
        e.preventDefault();
        app.toggleNav();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Audio files dragged onto the page go into the patch (and the library). Not on a listener's page: no library there. */
function useFileDrop(): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (app.listening) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const overHandler = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      app.addFiles(files).catch((err) => app.engine.info((err as Error).message));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overHandler);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overHandler);
      window.removeEventListener('drop', drop);
    };
  }, []);
  return over;
}

/** What a listener's start screen says is on air. */
function OnAirNow() {
  const s = app.radio.status;
  const doc = app.radio.latest?.doc;
  const modules = doc ? Object.keys(doc.modules).length : 0;
  const what = doc ? `“${doc.title === UNTITLED ? 'untitled session' : doc.title}” (${modules} module${modules === 1 ? '' : 's'})` : '';
  if (!s) return <p className="dim">Tuning in…</p>;
  if (!s.session) return <p>Nothing has been on air yet. Start audio anyway, and it plays here when {HOST} goes on air.</p>;
  if (!s.live) return <p>Off air since {new Date(s.since).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}. The last patch, {what}, still plays.</p>;
  return <p>On air: {what}. Your browser plays it; the knobs are yours to turn.</p>;
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
            {app.state === 'booting' ? 'starting scsynth…' : app.state === 'restoring' ? (app.listening ? 'tuning in…' : 'bringing your patch back…') : 'start audio'}
          </button>
          {app.listening && app.state === 'off' && <OnAirNow />}
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
  const dropping = useFileDrop();
  const [showSettings, setShowSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const rt = app.runtime;
  // A listener's page: what's on air instead of the library, the conversation to read instead of the chat.
  const listening = app.listening;
  const nav = app.navOpen && !listening;

  return (
    <div className={`app${app.stopped ? ' is-stopped' : ''}${listening ? ' listening' : ''}`}>
      {listening && <NetworkStrip />}
      <header className="top">
        <div className="brand-row">{listening ? <OnAirTitle /> : <SessionMenu />}</div>
        {app.state === 'ready' ? <Transport /> : <div />}
        <div className="row">
          {listening && <FollowSwitch />}
          <MasterMeter />
          {!listening && (
            <>
              <button className="ghost" disabled={!rt.canUndo} onClick={() => void rt.undo()} title="undo (⌘Z)">↶</button>
              <button className="ghost" disabled={!rt.canRedo} onClick={() => void rt.redo()} title="redo (⌘⇧Z)">↷</button>
            </>
          )}
          <button className="ghost" onClick={() => setShowLog(!showLog)}>log</button>
          <button className="ghost" onClick={() => setShowSettings(!showSettings)}>settings</button>
        </div>
      </header>

      <StartScreen />

      <main className={`main${nav ? ' with-nav' : ''}`}>
        {nav && (
          <aside className="nav-col">
            <Navigator />
          </aside>
        )}
        <aside className="left">
          {listening ? (
            <Transcript />
          ) : (
            <Suspense key={app.session} fallback={<div className="chat-loading dim">opening the conversation…</div>}>
              <AgentChat />
            </Suspense>
          )}
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
      <Dialogs />
      <Toast />
      {dropping && (
        <div className="drop-overlay">
          <div>{app.state === 'ready' ? 'Drop audio files to add them to the patch' : 'Start audio first, then drop the files'}</div>
        </div>
      )}
    </div>
  );
}
