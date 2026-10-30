// The library's dialogs: rename, a new song or set, an AGENTS.md, delete,
// name a checkpoint, clear the patch. One at a time, from app.dialog.

import { useEffect, useState, type ReactNode } from 'react';
import { app, useEmitter, type Dialog as DialogState, type Entry } from '../app/store';
import { UNTITLED } from '../app/tree';

export function useRun() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown> | unknown, after?: () => void) => {
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

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
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

/** What an entry is called. */
export function nameOf(entry: Entry): string {
  const t = app.tree;
  if (entry.type === 'session') return entry.id === app.session ? app.runtime.doc.title : t.sessions.find((s) => s.name === entry.id)?.title ?? 'that session';
  if (entry.type === 'song') return t.songs.find((s) => s.id === entry.id)?.name ?? 'that song';
  return t.sets.find((s) => s.id === entry.id)?.name ?? 'that set';
}

function NameForm({ initial, placeholder, action, onSubmit, onClose, children }: { initial: string; placeholder: string; action: string; onSubmit: (name: string) => Promise<unknown> | unknown; onClose: () => void; children?: ReactNode }) {
  const { error, busy, run } = useRun();
  const [name, setName] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void run(() => onSubmit(name.trim()), onClose);
      }}
    >
      <input autoFocus className="dialog-input" value={name} placeholder={placeholder} maxLength={120} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
      {children}
      {error && <p className="error">{error}</p>}
      <div className="row end">
        <button type="button" className="ghost" onClick={onClose}>cancel</button>
        <button type="submit" disabled={busy || !name.trim()}>{action}</button>
      </div>
    </form>
  );
}

function RenameDialog({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const current = nameOf(entry);
  return (
    <Dialog title={`Rename ${entry.type}`} onClose={onClose}>
      <NameForm
        initial={current === UNTITLED ? '' : current}
        placeholder={entry.type === 'set' ? 'warehouse set' : entry.type === 'song' ? 'night drive' : 'dub chords'}
        action="rename"
        onClose={onClose}
        onSubmit={(name) => {
          if (entry.type === 'session') app.renameSession(entry.id, name);
          else if (entry.type === 'song') app.renameSong(entry.id, name);
          else app.renameSet(entry.id, name);
        }}
      />
    </Dialog>
  );
}

function CreateDialog({ type, setId, fileSession, onClose }: { type: 'song' | 'set'; setId?: string | null; fileSession?: string; onClose: () => void }) {
  const set = setId ? app.tree.sets.find((s) => s.id === setId) : null;
  return (
    <Dialog title={type === 'set' ? 'New set' : 'New song'} onClose={onClose}>
      <NameForm
        initial=""
        placeholder={type === 'set' ? 'warehouse set' : 'night drive'}
        action={`make the ${type}`}
        onClose={onClose}
        onSubmit={async (name) => {
          if (type === 'set') await app.createSet(name);
          else await app.createSong(name, setId ?? null, fileSession);
        }}
      >
        <p className="dim">
          {type === 'set'
            ? 'A set holds songs, in order. Its AGENTS.md is read by every session in every song in it.'
            : `A song holds sessions${set ? `, in the set “${set.name}”` : ''}. Its AGENTS.md is read by every session in it.${fileSession ? ' This session goes in it.' : ''}`}
        </p>
      </NameForm>
    </Dialog>
  );
}

const CONTEXT_HINT = {
  person: 'Read by every session, wherever it is: how you like to work, your setup, your taste.',
  set: 'Read by every session in every song of this set: the set’s sound, its range of tempos and keys, how the songs flow into each other.',
  song: 'Read by every session in this song: its key, tempo, sounds, structure, the names of things. The agent adds to it when you ask it to remember something.',
};

const CONTEXT_PLACEHOLDER = {
  person: '- I play this live, so keep everything tweakable\n- Prefer analog-style drift; no bright digital pads',
  set: '- A dark techno set, 124–132 bpm\n- Every song ends on a filtered drone the next one starts from',
  song: '- D minor, 92 bpm, swung 16ths\n- The bass is a sine with a little fold; the hats are granular\n- Structure: intro 16 bars, groove, break at bar 64',
};

function ContextDialog({ level, id, onClose }: { level: 'person' | 'song' | 'set'; id?: string; onClose: () => void }) {
  const { error, busy, run } = useRun();
  const [text, setText] = useState(() => app.agentsOf(level, id));
  const owner = level === 'person' ? null : nameOf({ type: level, id: id! });
  const song = level === 'song' ? app.tree.songs.find((s) => s.id === id) : null;
  const set = song?.setId ? app.tree.sets.find((s) => s.id === song.setId) : null;
  return (
    <Dialog title={level === 'person' ? 'Your AGENTS.md' : `${owner} / AGENTS.md`} onClose={onClose} wide>
      <p className="dim">{CONTEXT_HINT[level]}</p>
      <textarea className="dialog-input agents-md" value={text} placeholder={CONTEXT_PLACEHOLDER[level]} rows={14} autoFocus onChange={(e) => setText(e.target.value)} />
      <p className="dim small">
        {level === 'song' && set ? `Sessions here also read ${set.name} / AGENTS.md and yours.` : level === 'person' ? 'Sets and songs add their own on top.' : 'Sessions here also read yours.'}
      </p>
      {error && <p className="error">{error}</p>}
      <div className="row end">
        <button className="ghost" onClick={onClose}>cancel</button>
        <button disabled={busy} onClick={() => void run(() => app.saveAgents(level, id, text), onClose)}>save</button>
      </div>
    </Dialog>
  );
}

function DeleteDialog({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const { error, busy, run } = useRun();
  const name = nameOf(entry);
  const t = app.tree;
  if (entry.type === 'session') {
    const branches = t.sessions.filter((s) => s.parent === entry.id).length;
    return (
      <Dialog title="Delete session" onClose={onClose}>
        <p>
          Delete “{name}”: its conversation, its checkpoints and its patch, for good.
          {branches ? ` Its ${branches} branch${branches === 1 ? '' : 'es'} keep${branches === 1 ? 's' : ''} what they took from it.` : ''}
        </p>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button className="ghost" onClick={onClose}>cancel</button>
          <button className="danger-solid" disabled={busy} onClick={() => void run(() => app.deleteSession(entry.id), onClose)}>delete</button>
        </div>
      </Dialog>
    );
  }
  const songs = entry.type === 'set' ? t.songs.filter((s) => s.setId === entry.id) : [];
  const sessions = t.sessions.filter((s) => (entry.type === 'song' ? s.songId === entry.id : songs.some((x) => x.id === s.songId))).length;
  const inside = entry.type === 'set' ? `${songs.length} song${songs.length === 1 ? '' : 's'}` : `${sessions} session${sessions === 1 ? '' : 's'}`;
  return (
    <Dialog title={`Delete ${entry.type}`} onClose={onClose}>
      <p>
        Delete “{name}” and its AGENTS.md. {entry.type === 'set' ? 'Its songs' : 'Its sessions'} ({inside}) can stay, moved up to the top, or go with it
        {entry.type === 'set' && sessions ? ` (with their ${sessions} session${sessions === 1 ? '' : 's'})` : ''}.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="row end">
        <button className="ghost" onClick={onClose}>cancel</button>
        <button disabled={busy} onClick={() => void run(() => app.deleteGroup(entry, false), onClose)}>delete, keep {entry.type === 'set' ? 'the songs' : 'the sessions'}</button>
        <button className="danger-solid" disabled={busy || (!sessions && !songs.length)} onClick={() => void run(() => app.deleteGroup(entry, true), onClose)}>
          delete everything
        </button>
      </div>
    </Dialog>
  );
}

function CheckpointDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keep a checkpoint" onClose={onClose}>
      <NameForm initial="" placeholder={`checkpoint ${app.checkpoints.filter((k) => k.kind === 'manual').length + 1}`} action="keep it" onClose={onClose} onSubmit={(name) => app.checkpointNow(name)}>
        <p className="dim">The patch as it is right now, in this session’s timeline: restore it, or start a branch from it, any time.</p>
      </NameForm>
    </Dialog>
  );
}

function ClearPatchDialog({ onClose }: { onClose: () => void }) {
  const { error, busy, run } = useRun();
  return (
    <Dialog title="Clear patch" onClose={onClose}>
      <p>Remove everything from “{app.runtime.doc.title}” and keep the conversation. ⌘Z brings it back.</p>
      {error && <p className="error">{error}</p>}
      <div className="row end">
        <button className="ghost" onClick={onClose}>cancel</button>
        <button className="danger-solid" disabled={busy} onClick={() => void run(() => app.clearPatch(), onClose)}>clear</button>
      </div>
    </Dialog>
  );
}

export function Dialogs() {
  useEmitter(app.uiEvents);
  const d: DialogState | null = app.dialog;
  if (!d) return null;
  const close = () => app.showDialog(null);
  switch (d.kind) {
    case 'rename':
      return <RenameDialog entry={d.entry} onClose={close} />;
    case 'create':
      return <CreateDialog type={d.type} setId={d.setId} fileSession={d.fileSession} onClose={close} />;
    case 'context':
      return <ContextDialog level={d.level} id={d.id} onClose={close} />;
    case 'delete':
      return <DeleteDialog entry={d.entry} onClose={close} />;
    case 'checkpoint':
      return <CheckpointDialog onClose={close} />;
    case 'clear-patch':
      return <ClearPatchDialog onClose={close} />;
  }
}
