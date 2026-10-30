// Samples in the interface: the Samples tab (every sample in the patch as a
// card with its waveform, beats and root, and pickers for Sonic Pi's pack and
// your library), and LoopView, a sampler module's waveform with its loop
// region and moving playhead for the Selected panel. Audio files dropped
// anywhere on the page come in through App.

import { useEffect, useRef, useState } from 'react';
import { app, useEmitter } from '../app/store';
import { library, stockSamples, type LibrarySample, type StockSample } from '../app/library';
import { noteName } from '../engine/analysis';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** A min/max waveform, beat lines when it has beats, and (optionally) a loop region and playhead in beats. */
function drawWave(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  opts: { beats?: number; accent: string; region?: [number, number]; reverse?: boolean; playhead?: number },
) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const x = (beat: number) => (opts.beats ? (beat / opts.beats) * w : 0);
  if (opts.region && opts.beats) {
    const [a, b] = opts.region;
    g.fillStyle = 'rgba(232, 194, 122, 0.13)';
    g.fillRect(x(a), 0, Math.max(1, x(b) - x(a)), h);
  }
  if (opts.beats) {
    g.strokeStyle = css('--line2');
    g.lineWidth = 1;
    for (let b = 1; b < opts.beats; b++) {
      g.globalAlpha = b % 4 === 0 ? 0.9 : 0.35;
      g.beginPath();
      g.moveTo(Math.round(x(b)) + 0.5, 0);
      g.lineTo(Math.round(x(b)) + 0.5, h);
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  const n = peaks.length / 2;
  if (n) {
    g.fillStyle = opts.accent;
    const mid = h / 2;
    for (let i = 0; i < n; i++) {
      const lo = peaks[2 * i], hi = peaks[2 * i + 1];
      const px = (i / n) * w;
      g.fillRect(px, mid - hi * mid, Math.max(1, w / n), Math.max(1, (hi - lo) * mid));
    }
  }
  if (opts.playhead !== undefined && opts.beats) {
    g.fillStyle = css('--text');
    g.fillRect(Math.round(x(opts.playhead)), 0, 2, h);
  }
}

function Wave({ src, beats, height = 46 }: { src: string; beats?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const loaded = app.bank.get(src);
  useEffect(() => {
    if (ref.current && loaded) drawWave(ref.current, loaded.peaks, { beats, accent: css('--audio') });
  });
  return <canvas ref={ref} className="wave" style={{ height }} />;
}

function SampleCard({ name }: { name: string }) {
  const rt = app.runtime;
  const doc = rt.doc.samples[name];
  const a = app.bank.get(doc.src)?.analysis;
  const users = rt.sampleUsers(name);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    rt.checkpoint();
    fn().catch((e) => setError((e as Error).message));
  };
  const bpm = doc.beats ? round((doc.beats * 60) / doc.duration, 1) : null;
  return (
    <div className="sample-card">
      <div className="row between">
        <div className="row">
          <button className="ghost tiny play" title="listen" onClick={() => app.audition(name)}>▶</button>
          <strong>{name}</strong>
          <span className="dim">{a?.kind ?? ''}</span>
        </div>
        {!app.listening && (
          <button
            className="ghost tiny"
            title={users.length ? `played by ${users.join(', ')}` : 'take it out of the patch'}
            disabled={users.length > 0}
            onClick={() => run(() => rt.removeSample(name))}
          >
            ×
          </button>
        )}
      </div>
      <Wave src={doc.src} beats={doc.beats} />
      <div className="sample-facts dim" title={doc.file ?? doc.src}>
        {doc.file ?? doc.src} · {round(doc.duration)} s · {doc.channels === 1 ? 'mono' : doc.channels === 2 ? 'stereo' : `${doc.channels} ch`}
        {bpm && <> · {bpm} bpm as cut</>}
        {users.length > 0 && <> · played by {users.join(', ')}</>}
        {app.listening && doc.beats !== undefined && <> · {doc.beats} beats</>}
        {app.listening && doc.root !== undefined && <> · root {noteName(440 * 2 ** ((doc.root - 69) / 12))}</>}
      </div>
      {!app.listening && (
        <div className="row sample-fields">
          <label title="how many beats it spans: QLoop plays it in time at any tempo">
            beats
            <select value={doc.beats ?? ''} onChange={(e) => run(() => rt.defineSample(name, { beats: e.target.value ? Number(e.target.value) : null }))}>
              <option value="">—</option>
              {[...new Set([...(a?.beatsCandidates ?? []), 1, 2, 4, 8, 16, 32, 64, ...(doc.beats ? [doc.beats] : [])])].sort((x, y) => x - y).map((n) => (
                <option key={n} value={n}>
                  {n} ({round((n * 60) / doc.duration, 1)} bpm)
                </option>
              ))}
            </select>
          </label>
          <label title="the note it sounds at: OneShot's note plays in tune from it">
            root
            <input
              className="num"
              defaultValue={doc.root !== undefined ? round(doc.root) : ''}
              placeholder={a?.root ? String(round(a.root)) : '—'}
              onBlur={(e) => {
                const v = e.target.value.trim();
                const n = v === '' ? null : Number(v);
                if (n === null || Number.isFinite(n)) run(() => rt.defineSample(name, { root: n }));
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            {doc.root !== undefined && <span className="dim note">{noteName(440 * 2 ** ((doc.root - 69) / 12))}</span>}
          </label>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** Sonic Pi's pack and your library, to add from. */
function AddSample() {
  const [stock, setStock] = useState<StockSample[]>([]);
  const [lib, setLib] = useState<LibrarySample[] | null>(null);
  const [category, setCategory] = useState('loop');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void stockSamples().then(setStock);
    library.samples().then(setLib, () => setLib([]));
  }, []);
  const categories = [...new Set(stock.map((x) => x.category))];
  const add = async (label: string, src: string, file: string) => {
    setError(null);
    setBusy(label);
    try {
      const doc = app.runtime.doc.samples;
      let name = label.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 28) || 'sample';
      for (let n = 2; doc[name] && doc[name].src !== src; n++) name = `${label.slice(0, 26)}_${n}`;
      app.runtime.checkpoint();
      await app.runtime.defineSample(name, { src, file });
      app.note(`added the sample '${name}' (${file})`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="add-sample">
      <div className="row wrap">
        <span className="dim">Sonic Pi:</span>
        {categories.map((c) => (
          <button key={c} className={`chip${c === category ? ' on' : ''}`} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="row wrap stock-names">
        {stock
          .filter((x) => x.category === category)
          .map((x) => (
            <button key={x.name} className="ghost small" disabled={busy !== null} title={`add ${x.name}`} onClick={() => void add(x.name, `stock:${x.name}`, `${x.name}.flac`)}>
              {busy === x.name ? '…' : '+'} {x.name.replace(`${category}_`, '')}
            </button>
          ))}
      </div>
      {lib && lib.length > 0 && (
        <div className="row wrap stock-names">
          <span className="dim">your library:</span>
          {lib.map((x) => (
            <button key={x.hash} className="ghost small" disabled={busy !== null} onClick={() => void add(x.name, `lib:${x.hash}`, x.name)}>
              {busy === x.name ? '…' : '+'} {x.name}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** Record bars of a module (or the mix) into a new sample, from the next bar line. */
function RecordRow() {
  useEmitter(app.patchEvents);
  useEmitter(app.uiEvents);
  const rt = app.runtime;
  const sources = [
    'master',
    ...Object.keys(rt.doc.subpatches).filter((p) => !p.includes('/')),
    ...rt.moduleNames().filter((m) => rt.module(m)?.compiled.shape.rate === 'audio'),
  ];
  const [source, setSource] = useState('master');
  const [bars, setBars] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const rec = app.recording;
  return (
    <div className="row wrap record-row">
      <span className="dim">record</span>
      <select value={sources.includes(source) ? source : 'master'} onChange={(e) => setSource(e.target.value)} disabled={!!rec}>
        {sources.map((x) => (
          <option key={x} value={x}>
            {x === 'master' ? 'the mix' : x}
          </option>
        ))}
      </select>
      <span className="dim">for</span>
      <select value={bars} onChange={(e) => setBars(Number(e.target.value))} disabled={!!rec}>
        {[1, 2, 4, 8, 16].map((n) => (
          <option key={n} value={n}>
            {n} bar{n === 1 ? '' : 's'}
          </option>
        ))}
      </select>
      <button
        className={`rec${rec ? ' on' : ''}`}
        disabled={!!rec || app.stopped}
        title={app.stopped ? 'press play first' : 'starts on the next bar line; the new sample loops perfectly'}
        onClick={() => {
          setError(null);
          app.record(sources.includes(source) ? source : 'master', bars).catch((e) => setError((e as Error).message));
        }}
      >
        ● {rec ? `recording ${rec.source === 'master' ? 'the mix' : rec.source}…` : 'record'}
      </button>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

export function SamplesPanel() {
  useEmitter(app.patchEvents);
  useEmitter(app.uiEvents);
  const names = Object.keys(app.runtime.doc.samples);
  return (
    <div className="samples-panel">
      {app.state !== 'ready' ? (
        <p className="dim pad">Samples load once audio has started.</p>
      ) : (
        <>
          <div className="sample-cards">
            {names.map((n) => (
              <SampleCard key={n} name={n} />
            ))}
            {app.incoming.map((f) => (
              <div key={f} className="sample-card loading dim">reading {f}…</div>
            ))}
            {names.length === 0 && app.incoming.length === 0 && (
              <p className="dim pad">
                {app.listening ? 'The patch on air plays no samples.' : "No samples yet. Drop audio files anywhere on the page, pick from Sonic Pi's pack below, or ask for one."}
              </p>
            )}
          </div>
          {/* Both write to the library: the host's page only. */}
          {!app.listening && (
            <>
              <RecordRow />
              <AddSample />
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A sampler module's waveform: for a QLoop, its loop region and playhead,
 * moving with the transport between the engine's reports.
 */
export function LoopView({ module }: { module: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = app.runtime.module(module);
  const sampleName = live ? Object.values(live.samples)[0] : undefined;
  const doc = sampleName ? app.runtime.doc.samples[sampleName] : undefined;
  useEffect(() => {
    if (!live || !doc) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const loaded = app.bank.get(doc.src);
      const canvas = ref.current;
      if (!loaded || !canvas) return;
      const h = live.compiled.playhead ? app.engine.playheads.get(live.meterId) : undefined;
      let opts: Parameters<typeof drawWave>[2] = { beats: doc.beats, accent: css('--audio') };
      if (h && performance.now() - h.time < 1000) {
        // Carry the reported position forward at the transport's rate until the next report.
        const bps = app.seq.bpm / 60;
        const moved = ((performance.now() - h.time) / 1000) * bps * h.rate * (h.reverse ? -1 : 1);
        const within = ((((h.pos - h.start + moved) % h.length) + h.length) % h.length) + h.start;
        opts = { beats: h.beats, accent: css('--audio'), region: [h.start, h.start + h.length], playhead: app.stopped ? h.pos : within };
      }
      drawWave(canvas, loaded.peaks, opts);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [live, doc]);
  if (!live || !doc) return null;
  return (
    <section className="knob-group loop-view">
      <h3 style={{ color: 'var(--audio)' }}>
        {sampleName} <span className="dim">{doc.file}</span>
      </h3>
      <canvas ref={ref} className="wave big" />
    </section>
  );
}
