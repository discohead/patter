// The patch, as a document: its title (with • while it differs from its
// saved copy) opens a menu to save, open, rename, start over, import and
// export. Everything also autosaves into the session, so the library holds
// the named versions and "Recent sessions" holds everything else.

import { useEffect, useRef, useState } from 'react';
import { app, useEmitter } from '../app/store';
import { library, type PatchSummary, type SessionSummary } from '../app/library';

function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

function useRun() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      after?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function NameDialog({ mode, onClose }: { mode: 'save-as' | 'rename'; onClose: () => void }) {
  const { error, busy, run } = useRun();
  const title = app.runtime.doc.title;
  const [name, setName] = useState(title === 'untitled patch' ? '' : title);
  const submit = () =>
    run(async () => {
      if (!name.trim()) throw new Error('give it a name');
      if (mode === 'save-as') await app.saveAs(name);
      else app.rename(name);
    }, onClose);
  return (
    <Dialog title={mode === 'save-as' ? 'Save patch as' : 'Rename patch'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input autoFocus className="dialog-input" value={name} placeholder="night drone" maxLength={120} onChange={(e) => setName(e.target.value)} />
        {mode === 'save-as' && <p className="dim">Saved patches live in your library on the server: open them from any browser.</p>}
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>cancel</button>
          <button type="submit" disabled={busy || !name.trim()}>{mode === 'save-as' ? 'save' : 'rename'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function ConfirmDialog({ mode, onClose }: { mode: 'new' | 'clear'; onClose: () => void }) {
  const { error, busy, run } = useRun();
  const title = app.runtime.doc.title;
  const unsaved = app.dirty && Object.keys(app.runtime.doc.modules).length > 0;
  return (
    <Dialog title={mode === 'new' ? 'New patch' : 'Clear patch'} onClose={onClose}>
      {mode === 'new' ? (
        <p>
          Start an empty patch with a fresh conversation. “{title}” and its conversation stay under <b>Open → Recent sessions</b>
          {unsaved ? '; it isn’t in your library, so save it if you want it there by name.' : '.'}
        </p>
      ) : (
        <p>Remove everything from “{title}” and keep the conversation. ⌘Z brings it back.</p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row end">
        <button className="ghost" onClick={onClose}>cancel</button>
        {mode === 'new' && unsaved && (
          <button className="ghost" disabled={busy} onClick={() => app.showDialog('save-as')}>
            save first
          </button>
        )}
        <button className={mode === 'clear' ? 'danger-solid' : ''} disabled={busy} onClick={() => void run(() => (mode === 'new' ? app.newPatch() : app.clearPatch()), onClose)}>
          {mode === 'new' ? 'new patch' : 'clear'}
        </button>
      </div>
    </Dialog>
  );
}

function OpenDialog({ onClose }: { onClose: () => void }) {
  const { error, busy, run } = useRun();
  const [data, setData] = useState<{ patches: PatchSummary[]; sessions: SessionSummary[] } | null>(null);
  const [filter, setFilter] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = () => run(async () => setData(await library.list()));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const f = filter.trim().toLowerCase();
  const patches = (data?.patches ?? []).filter((p) => !f || p.name.toLowerCase().includes(f));
  const sessions = (data?.sessions ?? []).filter((s) => (s.modules > 0 || s.name === app.session) && (!f || s.title.toLowerCase().includes(f)));
  return (
    <Dialog title="Open" onClose={onClose} wide>
      <input autoFocus className="dialog-input" value={filter} placeholder="filter by name" onChange={(e) => setFilter(e.target.value)} />
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="dim">loading…</p>}
      {data && (
        <div className="open-lists">
          <section>
            <h4>Saved patches</h4>
            {patches.length === 0 ? (
              <p className="dim">{data.patches.length ? 'nothing matches' : 'Nothing saved yet: ⌘S saves the patch you’re on.'}</p>
            ) : (
              <ul className="open-list">
                {patches.map((p) => (
                  <li key={p.id} className={p.id === app.libraryId ? 'current' : ''}>
                    <button className="open-main" disabled={busy} onClick={() => void run(() => app.openPatch(p.id), onClose)} title="open in a fresh session">
                      <span className="open-name">{p.name}</span>
                      <span className="dim">
                        {p.modules} module{p.modules === 1 ? '' : 's'}
                        {p.subpatches ? ` · ${p.subpatches} subpatch${p.subpatches === 1 ? '' : 'es'}` : ''} · {ago(p.updated)}
                      </span>
                    </button>
                    {confirm === p.id ? (
                      <button
                        className="ghost danger"
                        onClick={() =>
                          void run(async () => {
                            await library.remove(p.id);
                            if (app.libraryId === p.id) app.libraryId = null;
                            setConfirm(null);
                            setData(await library.list());
                          })
                        }
                      >
                        delete for good
                      </button>
                    ) : (
                      <button className="ghost" title="delete from the library" onClick={() => setConfirm(p.id)}>
                        delete
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h4>Recent sessions</h4>
            <p className="dim small">Each is a conversation and the patch it was about, as you left it.</p>
            {sessions.length === 0 ? (
              <p className="dim">none yet</p>
            ) : (
              <ul className="open-list">
                {sessions.map((s) => (
                  <li key={s.name} className={s.name === app.session ? 'current' : ''}>
                    <button
                      className="open-main"
                      disabled={busy || s.name === app.session}
                      onClick={() => void run(() => app.resumeSession(s.name), onClose)}
                      title={s.name === app.session ? 'you are here' : 'resume this conversation and its patch'}
                    >
                      <span className="open-name">{s.title}</span>
                      <span className="dim">
                        {s.modules} module{s.modules === 1 ? '' : 's'} · {s.name === app.session ? 'this session' : ago(s.updated)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      <div className="row end">
        <button className="ghost" onClick={onClose}>close</button>
      </div>
    </Dialog>
  );
}

export function PatchMenu() {
  useEmitter(app.uiEvents);
  useEmitter(app.patchEvents);
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = app.state === 'ready';
  // Before audio starts, the patch this session will pick up.
  const title = ready ? app.runtime.doc.title : app.resumes?.title ?? app.runtime.doc.title;
  const close = () => app.showDialog(null);

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
      <button className="patch-title" onClick={() => setOpen(!open)} title={app.dirty ? 'unsaved changes (the session still has them)' : 'the patch'}>
        <span className="patch-name">{title}</span>
        {app.dirty && Object.keys(app.runtime.doc.modules).length > 0 && <span className="dirty">•</span>}
        <span className="caret">▾</span>
      </button>
      {error && (
        <span className="error small" title={error}>
          {error}
        </span>
      )}
      {open && (
        <div className="menu" role="menu">
          <button disabled={!ready} onClick={act(() => app.save())}>
            Save <kbd>⌘S</kbd>
          </button>
          <button disabled={!ready} onClick={act(() => app.showDialog('save-as'))}>Save as…</button>
          <button disabled={!ready} onClick={act(() => app.showDialog('open'))}>
            Open… <kbd>⌘O</kbd>
          </button>
          <hr />
          <button disabled={!ready} onClick={act(() => app.showDialog('rename'))}>Rename…</button>
          <button disabled={!ready} onClick={act(() => app.showDialog('new'))}>New patch</button>
          <button disabled={!ready} onClick={act(() => app.showDialog('clear'))}>Clear patch</button>
          <hr />
          <button disabled={!ready} onClick={act(() => fileRef.current?.click())}>Import file…</button>
          <button onClick={act(exportFile)}>Export file</button>
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
      {app.dialog === 'open' && <OpenDialog onClose={close} />}
      {(app.dialog === 'save-as' || app.dialog === 'rename') && <NameDialog key={app.dialog} mode={app.dialog} onClose={close} />}
      {(app.dialog === 'new' || app.dialog === 'clear') && <ConfirmDialog key={app.dialog} mode={app.dialog} onClose={close} />}
    </div>
  );
}
