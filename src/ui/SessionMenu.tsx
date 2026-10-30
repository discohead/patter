// The session you're in, at the top: where it lives (set / song /) and its
// title, which opens what you can do with it — rename, keep a checkpoint,
// branch, start afresh with the patch, file it, import and export, clear the
// patch, delete. The library itself is the navigator on the left (☰).

import { useEffect, useRef, useState } from 'react';
import { app, useEmitter } from '../app/store';
import { UNTITLED } from '../app/tree';

export function SessionMenu() {
  useEmitter(app.uiEvents);
  useEmitter(app.patchEvents);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const ready = app.state === 'ready';
  // Before audio starts, the patch this session will pick up.
  const title = ready ? app.runtime.doc.title : app.resumes?.title ?? app.entry?.title ?? app.runtime.doc.title;
  const song = app.song;
  const set = app.set;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const act = (fn: () => unknown) => () => {
    setOpen(false);
    setError(null);
    Promise.resolve(fn()).catch((e) => setError((e as Error).message));
  };
  const exportFile = () => {
    const blob = new Blob([app.exportPatch()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'patch'}.patter.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="patch-menu" ref={menuRef}>
      <button className={`ghost nav-toggle${app.navOpen ? ' on' : ''}`} title="the library: sets, songs, sessions (⌘\)" onClick={() => app.toggleNav()}>
        ☰
      </button>
      <span className="brand">patter</span>
      <span className="session-crumbs">
        {set && (
          <button className="crumb" title={`the set “${set.name}”: its AGENTS.md`} onClick={() => app.showDialog({ kind: 'context', level: 'set', id: set.id })}>
            {set.name}
          </button>
        )}
        {set && <span className="crumb-sep">/</span>}
        {song && (
          <button className="crumb" title={`the song “${song.name}”: its AGENTS.md`} onClick={() => app.showDialog({ kind: 'context', level: 'song', id: song.id })}>
            {song.name}
          </button>
        )}
        {song && <span className="crumb-sep">/</span>}
      </span>
      <button className="patch-title" onClick={() => setOpen(!open)} title="this session">
        <span className={`patch-name${title === UNTITLED ? ' untitled' : ''}`}>{title === UNTITLED ? 'untitled session' : title}</span>
        <span className="caret">▾</span>
      </button>
      {app.autosave === 'offline' && (
        <span className="error small" title="the library is unreachable: changes are kept in this browser until it's back">
          offline
        </span>
      )}
      {error && (
        <span className="error small" title={error}>
          {error}
        </span>
      )}
      {open && (
        <div className="menu" role="menu">
          <button onClick={act(() => app.showDialog({ kind: 'rename', entry: { type: 'session', id: app.session } }))}>Rename…</button>
          <button disabled={!ready} onClick={act(() => app.showDialog({ kind: 'checkpoint' }))}>
            Keep a checkpoint… <kbd>⌘S</kbd>
          </button>
          <hr />
          <button onClick={act(() => app.branch({ keep: 'all' }))}>Branch: a copy that goes its own way</button>
          <button onClick={act(() => app.freshStart())}>Clear the conversation (keep the patch)</button>
          <button onClick={act(() => app.newSession(app.entry?.songId ?? null))}>New session{song ? ` in “${song.name}”` : ''}</button>
          <hr />
          {song ? (
            <button onClick={act(() => app.moveSession(app.session, null))}>Take it out of “{song.name}”</button>
          ) : (
            <button onClick={act(() => app.showDialog({ kind: 'create', type: 'song', fileSession: app.session }))}>Make it a song…</button>
          )}
          <button disabled={!ready} onClick={act(() => fileRef.current?.click())}>Import a patch file…</button>
          <button onClick={act(exportFile)}>Export the patch</button>
          <button disabled={!ready} onClick={act(() => app.showDialog({ kind: 'clear-patch' }))}>Clear the patch…</button>
          <hr />
          <button className="danger" onClick={act(() => app.showDialog({ kind: 'delete', entry: { type: 'session', id: app.session } }))}>Delete session…</button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            await app.importPatch(JSON.parse(await file.text()));
          } catch (err) {
            setError(`import: ${(err as Error).message}`);
          }
        }}
      />
    </div>
  );
}
