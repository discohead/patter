// Recording the mix: ● REC and ⟲ capture in the header, the note that pops
// up when a take is done, and the Recordings tab — every take kept in this
// browser, to play, download (24-bit WAV), bring into the patch, or delete.

import { useEffect, useRef, useState } from 'react';
import { app, useEmitter } from '../app/store';
import { formatTime } from '../app/recorder';
import { PEAK_SECONDS, type Take } from '../app/takes';

/** Re-render every `ms` while `on`. */
function useTicker(on: boolean, ms = 100) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [on, ms]);
}

/** ● REC: armed → recording → finishing, each on a bar line. */
export function RecordButton() {
  useEmitter(app.uiEvents);
  const rec = app.recorder.rec;
  useTicker(Boolean(rec));
  const beat = rec ? app.recorder.beatNow() : null;
  const toGo = (target: number) => Math.max(1, Math.ceil(target - (beat ?? target) - 1e-6));
  let label = 'REC';
  let title = 'record the mix from the next bar line; press again to end on the bar line after (⌥R)';
  if (rec?.phase === 'armed') {
    label = `in ${toGo(rec.startBeat)}`;
    title = 'starts on the next bar line — press again to cancel (⌥R)';
  } else if (rec?.phase === 'recording') {
    label = formatTime(app.recorder.elapsed());
    title = 'recording the mix — press to end on the next bar line (⌥R)';
  } else if (rec?.phase === 'finishing') {
    label = rec.endBeat !== null ? `ends in ${toGo(rec.endBeat)}` : 'ending';
    title = 'ends on the next bar line — press again to end right now (⌥R)';
  } else if (rec?.phase === 'saving') {
    label = 'saving';
  }
  return (
    <button
      className={`rec-button${rec ? ` ${rec.phase}` : ''}`}
      disabled={!app.recorder.available}
      title={app.recorder.available ? title : app.recorder.tap.error ?? 'recording starts with the audio'}
      onClick={() => app.toggleRecord()}
    >
      <span className="rec-dot" />
      {label}
    </button>
  );
}

/** ⟲: the last N minutes of the mix, now. */
export function CaptureButton() {
  useEmitter(app.uiEvents);
  const minutes = app.settings.captureMinutes;
  const busy = app.recorder.capturing;
  return (
    <button
      className={`capture-button${busy ? ' busy' : ''}`}
      disabled={!app.recorder.available || busy}
      title={`keep the last ${minutes} minute${minutes === 1 ? '' : 's'} of the mix as a take (⌥C) — how long is in settings`}
      onClick={() => void app.capture()}
    >
      ⟲ {busy ? 'saving…' : `${minutes} min`}
    </button>
  );
}

export function Toast() {
  useEmitter(app.uiEvents);
  const t = app.toast;
  if (!t) return null;
  const take = t.take ? app.takeById(t.take) : undefined;
  return (
    <div className={`toast${t.error ? ' error' : ''}`} key={t.id}>
      <span>{t.text}</span>
      {take && (
        <>
          <button onClick={() => void app.downloadTake(take.id)}>⬇ WAV</button>
          <button className="ghost" onClick={() => app.showPanel('recordings')}>
            recordings
          </button>
        </>
      )}
      <button className="ghost tiny" title="dismiss" onClick={() => app.dismissToast()}>
        ×
      </button>
    </div>
  );
}

// ── playing takes back ──────────────────────────────────────────────────────

/** One take plays at a time, through an <audio> element (not into the mix, so not into the capture buffer). */
const player = {
  id: null as string | null,
  audio: null as HTMLAudioElement | null,
  url: '',
  listeners: new Set<() => void>(),
  emit() {
    for (const fn of this.listeners) fn();
  },
  stop() {
    this.audio?.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.audio = null;
    this.url = '';
    this.id = null;
    this.emit();
  },
  async play(take: Take, at = 0) {
    if (this.id === take.id && this.audio) {
      this.audio.currentTime = at * (take.frames / take.sampleRate);
      void this.audio.play();
      return;
    }
    this.stop();
    this.id = take.id;
    this.emit();
    const blob = await app.recorder.wav(take);
    if (this.id !== take.id) return;
    this.url = URL.createObjectURL(blob);
    const audio = new Audio(this.url);
    this.audio = audio;
    audio.onended = () => this.stop();
    audio.currentTime = at * (take.frames / take.sampleRate);
    await audio.play().catch(() => this.stop());
    this.emit();
  },
};

function usePlayer() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    player.listeners.add(fn);
    return () => {
      player.listeners.delete(fn);
    };
  }, []);
  return player;
}

function TakeWave({ take, playing }: { take: Take; playing: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = ref.current;
      if (!c) return;
      const w = c.clientWidth;
      const h = c.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
      if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const pairs = take.peaks.length / 2;
      const seconds = take.frames / take.sampleRate;
      const shown = Math.min(pairs, Math.ceil(seconds / PEAK_SECONDS));
      // Whole bars: a faint line at each bar.
      if (take.bars && take.bars <= 128) {
        g.fillStyle = 'rgba(255,255,255,0.08)';
        for (let b = 1; b < take.bars; b++) g.fillRect(Math.round((b / take.bars) * w), 0, 1, h);
      }
      g.fillStyle = take.kind === 'recording' ? '#fc8181' : '#e8c27a';
      for (let x = 0; x < w; x++) {
        const a = Math.floor((x / w) * shown);
        const b = Math.max(a + 1, Math.floor(((x + 1) / w) * shown));
        let lo = 0;
        let hi = 0;
        for (let i = a; i < b && i < shown; i++) {
          lo = Math.min(lo, take.peaks[2 * i]);
          hi = Math.max(hi, take.peaks[2 * i + 1]);
        }
        const y0 = h / 2 - (hi * h) / 2;
        g.fillRect(x, y0, 1, Math.max(1, ((hi - lo) * h) / 2));
      }
      if (playing && player.audio && seconds > 0) {
        g.fillStyle = '#fff';
        g.fillRect(Math.round((player.audio.currentTime / seconds) * w), 0, 1, h);
        raf = requestAnimationFrame(draw);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [take, take.peaks, take.frames, playing]);
  return (
    <canvas
      ref={ref}
      className="take-wave"
      title="click to play from there"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        void player.play(take, Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width)));
      }}
    />
  );
}

function TakeRow({ take }: { take: Take }) {
  const p = usePlayer();
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState('');
  const recording = app.recorder.rec?.take === take;
  useTicker(recording, 500);
  const seconds = take.frames / take.sampleRate;
  const playing = p.id === take.id;
  const facts = [
    take.bars ? `${take.bars} bar${take.bars === 1 ? '' : 's'}` : '',
    formatTime(seconds),
    take.bpm ? `${Math.round(take.bpm * 10) / 10} bpm` : '',
    `${Math.round((take.frames * take.channels * 3) / 1e5) / 10} MB`,
    new Date(take.created).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  ].filter(Boolean);
  const run = (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    fn().finally(() => setBusy(''));
  };
  return (
    <div className={`take${recording ? ' live' : ''}`}>
      <div className="take-head">
        <span className={`take-kind ${take.kind}`} title={take.kind === 'recording' ? 'a recording (● REC)' : 'a capture (⟲)'}>
          {take.kind === 'recording' ? '●' : '⟲'}
        </span>
        {renaming ? (
          <input
            className="take-rename"
            autoFocus
            defaultValue={take.name}
            onBlur={(e) => {
              setRenaming(false);
              void app.renameTake(take.id, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              else if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <strong className="take-name" title="double-click to rename" onDoubleClick={() => setRenaming(true)}>
            {take.name}
          </strong>
        )}
        <span className="dim take-facts">
          {recording ? 'recording… · ' : ''}
          {facts.join(' · ')}
          {take.patch ? ` · ${take.patch}` : ''}
        </span>
        {take.volatile && <span className="error small" title="this browser's storage refused it">not stored: download it</span>}
      </div>
      <div className="take-body">
        <button className="take-play" disabled={recording || !take.frames} title={playing ? 'stop' : 'play'} onClick={() => (playing ? p.stop() : void p.play(take))}>
          {playing ? '■' : '▶'}
        </button>
        <TakeWave take={take} playing={playing} />
        <div className="take-actions">
          <button disabled={recording || !!busy} title="save the WAV file (24-bit) to your computer" onClick={() => run('wav', () => app.downloadTake(take.id))}>
            {busy === 'wav' ? '…' : '⬇ WAV'}
          </button>
          {/* A sample goes into the library: the host's page only. */}
          {!app.listening && (
            <button
              className="ghost"
              disabled={recording || !!busy || app.state !== 'ready'}
              title={take.bars ? `into the patch as a sample of ${take.bars * 4} beats (it loops)` : 'into the patch as a sample'}
              onClick={() => run('patch', () => app.takeToPatch(take.id))}
            >
              {busy === 'patch' ? '…' : '→ sample'}
            </button>
          )}
          {confirm ? (
            <button
              className="danger-solid"
              onClick={() => {
                if (playing) p.stop();
                void app.removeTake(take.id);
              }}
              onBlur={() => setConfirm(false)}
            >
              delete
            </button>
          ) : (
            <button className="ghost danger" disabled={recording} title="delete this take from this browser" onClick={() => setConfirm(true)}>
              ×
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function RecordingsPanel() {
  useEmitter(app.uiEvents);
  const takes = app.recorder.takes;
  const [usage, setUsage] = useState('');
  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => {
      if (e.usage !== undefined) setUsage(`${Math.round(e.usage / 1e6)} MB stored in this browser`);
    });
  }, [takes.length]);
  if (!takes.length) {
    return (
      <div className="surface empty">
        <p>
          <strong>● REC</strong> (<kbd>⌥R</kbd>) records the mix from the next bar line; press it again and the take ends on the bar line after, so it's whole bars. <strong>⟲</strong> (<kbd>⌥C</kbd>) keeps the
          last {app.settings.captureMinutes} minutes of the mix whenever you press it: it has been listening all along.
        </p>
        <p className="dim">Takes stay in this browser until you delete them, and download as 24-bit WAV files.</p>
      </div>
    );
  }
  return (
    <div className="takes">
      {takes.map((t) => (
        <TakeRow key={t.id} take={t} />
      ))}
      <div className="dim small takes-foot">{usage}</div>
    </div>
  );
}
