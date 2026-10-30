// On air, on a listener's page: in place of what only the host can do, a
// quiet line back to the datspace network (and to patter's source: it's
// AGPL), what's on air and since when, a Follow switch, and the
// conversation, to read.

import { Fragment, useEffect, useRef, useState } from 'react';
import { app, useEmitter } from '../app/store';
import type { TranscriptMessage, TranscriptTool } from '../app/on-air';
import { TOOL_LABEL } from '../app/transcript';
import { ago, UNTITLED } from '../app/tree';
import { renderText } from './AgentChat';

/** Who's at the controls: the one person who can prompt (Access lets in no one else). */
export const HOST = 'Jared';

const BANDS = ['io', 'ai', 'dev', 'fm', 'music', 'studio'];

function clock(t: number): string {
  const d = new Date(t);
  const today = d.toDateString() === new Date().toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ── a listener's page ───────────────────────────────────────────────────────

/** The datspace network, and where patter's source is: a quiet line across the top. */
export function NetworkStrip() {
  return (
    <div className="network">
      <a className="network-mark" href="https://datspace.io/">
        datspace
      </a>
      <nav className="network-bands" aria-label="the datspace network">
        {BANDS.map((band, i) => (
          <Fragment key={band}>
            {i > 0 && <span className="network-dot">·</span>}
            <a href={`https://datspace.${band}/`} className={band === 'studio' ? 'here' : undefined} aria-current={band === 'studio' ? 'page' : undefined}>
              {band}
            </a>
          </Fragment>
        ))}
      </nav>
      <span className="network-source">
        <a href="https://github.com/discohead/patter">Source</a> (AGPL-3.0-or-later) · sound by <a href="https://github.com/samaaron/supersonic">SuperSonic</a> (AGPL-3.0-or-later), SuperCollider in your browser
      </span>
    </div>
  );
}

/** What's on air, in a few words. */
function statusLine(): { text: string; live: boolean } {
  const r = app.radio;
  const s = r.status;
  if (!s) return { text: r.connection === 'lost' ? "can't reach the broadcast; trying again…" : 'tuning in…', live: false };
  const again = r.connection === 'lost' ? ' · reconnecting…' : '';
  if (!s.session) return { text: `nothing on air yet${again}`, live: false };
  if (!s.live) return { text: `off air since ${clock(s.since)}${again}`, live: false };
  const quiet = Date.now() - s.updatedAt > 10 * 60_000 ? ` · last change ${ago(s.updatedAt)} ago` : '';
  return { text: `on air${s.stopped ? ' · stopped' : ''}${quiet}${again}`, live: true };
}

/** Where a listener's page says what it's playing: patter, the session on air, and its state. */
export function OnAirTitle() {
  useEmitter(app.uiEvents);
  const s = app.radio.status;
  const title = s?.session ? (s.title === UNTITLED ? 'untitled session' : s.title) : '';
  const line = statusLine();
  return (
    <div className="patch-menu">
      <span className="brand">patter</span>
      {title && (
        <span className="patch-name listen-title" title={title}>
          {title}
        </span>
      )}
      <span className={`on-air-status${line.live ? ' live' : ''}`}>{line.text}</span>
    </div>
  );
}

/** Follow the host's changes (the default), or keep this page's own patch; with changes waiting, rejoin. */
export function FollowSwitch() {
  useEmitter(app.uiEvents);
  const r = app.radio;
  if (!r.status?.session) return null;
  return (
    <div className="row follow">
      {!r.following && r.missed > 0 && (
        <button className="ghost rejoin" title={`bring in ${HOST}'s patch as it is now, and follow again`} onClick={() => void r.follow(true)}>
          {r.missed} change{r.missed === 1 ? '' : 's'} waiting · rejoin
        </button>
      )}
      <label
        className="check"
        title={r.following ? `following: ${HOST}'s changes replace the patch here as they come (knobs you've turned included)` : `detached: the patch here is yours; ${HOST}'s changes wait until you rejoin`}
      >
        <input type="checkbox" checked={r.following} onChange={(e) => void r.follow(e.target.checked)} /> follow
      </label>
    </div>
  );
}

function ToolLine({ part }: { part: TranscriptTool }) {
  const [open, setOpen] = useState(false);
  const failed = part.state === 'error';
  return (
    <div className={`tool tool-${part.state}`}>
      <button className="tool-head" aria-expanded={open} disabled={!part.result} onClick={() => setOpen(!open)}>
        <span className="tool-dot" />
        <span>
          {TOOL_LABEL[part.name] ?? part.name}
          {part.subject ? ` · ${part.subject}` : ''}
        </span>
        {failed && <span className="tool-err">{part.result?.replace(/^ERROR:\s*/, '').slice(0, 100)}</span>}
        {part.state === 'stopped' && <span className="tool-note">not run: stopped</span>}
      </button>
      {open && part.result && (
        <div className="tool-body">
          <pre className={failed ? 'error' : 'result'}>{part.result}</pre>
        </div>
      )}
    </div>
  );
}

function Said({ m }: { m: TranscriptMessage }) {
  return (
    <div className={`msg-wrap ${m.role}`}>
      <div className={`msg ${m.role}`}>
        {m.parts.map((p, i) =>
          p.type === 'tool' ? <ToolLine key={i} part={p} /> : m.role === 'user' ? <Fragment key={i}>{p.text}</Fragment> : <Fragment key={i}>{renderText(p.text)}</Fragment>,
        )}
      </div>
    </div>
  );
}

/** The conversation on air, to read; in place of the composer, one line on who can prompt. */
export function Transcript() {
  useEmitter(app.uiEvents);
  const r = app.radio;
  const messages = r.transcript;
  const list = useRef<HTMLDivElement>(null);
  // Stay at the newest message as they arrive, unless the reader has scrolled back.
  const atEnd = useRef(true);
  useEffect(() => {
    if (list.current && atEnd.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages]);
  const s = r.status;
  return (
    <div className="chat transcript">
      <div
        className="chat-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {messages.length ? (
          messages.map((m) => <Said key={m.id} m={m} />)
        ) : (
          <div className="chat-hello">
            {!s ? (
              <p className="dim">Tuning in…</p>
            ) : !s.session ? (
              <>
                <p>Nothing has been on air yet.</p>
                <p className="dim">When {HOST} goes on air, the patch plays here, on your own copy of SuperCollider, and the conversation with the agent that builds it shows up in this column.</p>
              </>
            ) : (
              <p className="dim">Nothing's been said in this session yet.</p>
            )}
          </div>
        )}
      </div>
      <p className="listen-note">Only {HOST} can prompt. You're listening.</p>
    </div>
  );
}
