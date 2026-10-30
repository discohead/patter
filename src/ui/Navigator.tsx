// The library, on the left, like a file tree: your AGENTS.md, then sets (each
// with its AGENTS.md and its songs, in order), songs on their own (each with
// its AGENTS.md and its sessions), and sessions on their own. A session's
// branches sit under it. Nothing has to be filed: start a session, file it
// later. Drag a session onto a song to file it, a song onto a set (or onto a
// song, to put it there in the set list); drop on "sessions" to take it out.

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { app, useEmitter, type Entry } from '../app/store';
import type { SessionEntry, SetEntry, SongEntry } from '../app/library';
import { ago, families, UNTITLED, visibleSessions } from '../app/tree';

const FOLDED_KEY = 'patter.nav.folded.v1';
type Drag = { type: 'session' | 'song'; id: string };

function loadFolded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

// ── the ⋯ menu ──────────────────────────────────────────────────────────────

interface MenuItem {
  label: string;
  run?: () => unknown;
  /** A list to pick from (move to…). */
  pick?: { label: string; run: () => unknown; current?: boolean }[];
  danger?: boolean;
}

function Menu({ items, at, onClose }: { items: MenuItem[]; at: DOMRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const act = (fn: () => unknown) => () => {
    onClose();
    Promise.resolve(fn()).catch((e) => app.showToast((e as Error).message, { error: true }));
  };
  return createPortal(
    <div ref={ref} className="menu nav-menu" role="menu" style={{ top: Math.min(at.bottom + 2, window.innerHeight - 260), left: Math.min(at.left, window.innerWidth - 230) }}>
      {items.map((it) =>
        it.pick ? (
          <div key={it.label}>
            <button onClick={() => setOpen(open === it.label ? null : it.label)}>
              {it.label} <span className="dim">{open === it.label ? '▾' : '▸'}</span>
            </button>
            {open === it.label && (
              <div className="nav-pick">
                {it.pick.length === 0 && <span className="dim small">nowhere else yet</span>}
                {it.pick.map((p) => (
                  <button key={p.label} disabled={p.current} onClick={act(p.run)}>
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button key={it.label} className={it.danger ? 'danger' : ''} onClick={act(it.run!)}>
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

function More({ items, title }: { items: () => MenuItem[]; title: string }) {
  const [at, setAt] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        className="nav-btn"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          setAt(at ? null : e.currentTarget.getBoundingClientRect());
        }}
      >
        ⋯
      </button>
      {at && <Menu items={items()} at={at} onClose={() => setAt(null)} />}
    </>
  );
}

// ── rows ────────────────────────────────────────────────────────────────────

const pad = (depth: number) => ({ paddingLeft: 6 + depth * 14 });

function FileRow({ level, id, depth }: { level: 'person' | 'song' | 'set'; id?: string; depth: number }) {
  const text = app.agentsOf(level, id).trim();
  return (
    <div
      className={`nav-row file${text ? '' : ' empty'}`}
      style={pad(depth)}
      title={text ? text.slice(0, 400) : 'empty: click to write what every session here should know'}
      onClick={() => app.showDialog({ kind: 'context', level, id })}
    >
      <span className="nav-icon">≡</span>
      <span className="nav-name">AGENTS.md</span>
      {!text && <span className="nav-meta">empty</span>}
    </div>
  );
}

function SessionRow({ s, depth, branch, where }: { s: SessionEntry; depth: number; branch?: boolean; where?: string }) {
  const current = s.name === app.session;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);
  const title = current ? app.runtime.doc.title : s.title;
  const modules = current ? Object.keys(app.runtime.doc.modules).length : s.modules;
  const songs = app.tree.songs;
  const items = (): MenuItem[] => [
    ...(current ? [] : [{ label: 'Open', run: () => app.openSession(s.name) }]),
    { label: 'Rename…', run: () => app.showDialog({ kind: 'rename', entry: { type: 'session', id: s.name } }) },
    { label: 'Branch (a copy that goes its own way)', run: () => app.copySession(s.name) },
    {
      label: 'Move to',
      pick: [
        ...songs.map((x) => ({ label: `♫ ${x.name}`, run: () => app.moveSession(s.name, x.id), current: x.id === s.songId })),
        { label: '— on its own (no song)', run: () => app.moveSession(s.name, null), current: s.songId === null },
      ],
    },
    { label: 'New song with it…', run: () => app.showDialog({ kind: 'create', type: 'song', fileSession: s.name }) },
    { label: 'Delete…', run: () => app.showDialog({ kind: 'delete', entry: { type: 'session', id: s.name } }), danger: true },
  ];
  return (
    <div
      ref={ref}
      className={`nav-row session${current ? ' current' : ''}${branch ? ' branch' : ''}`}
      style={pad(depth)}
      draggable
      onDragStart={(e) => startDrag(e, { type: 'session', id: s.name })}
      onClick={() => void app.openSession(s.name).catch((e) => app.showToast((e as Error).message, { error: true }))}
      onDoubleClick={() => app.showDialog({ kind: 'rename', entry: { type: 'session', id: s.name } })}
      title={`${title}${where ? ` — in ${where}` : ''}\n${modules} module${modules === 1 ? '' : 's'} · ${s.turns} message${s.turns === 1 ? '' : 's'}${branch ? ' · a branch' : ''} · ${new Date(s.updated).toLocaleString()}`}
    >
      <span className="nav-icon">{branch ? '⑂' : current ? '●' : '○'}</span>
      <span className={`nav-name${title === UNTITLED ? ' untitled' : ''}`}>{title === UNTITLED ? 'untitled session' : title}</span>
      {where && <span className="nav-where">{where}</span>}
      <span className="nav-meta">{current ? 'here' : ago(s.updated)}</span>
      <More title="session…" items={items} />
    </div>
  );
}

function Family({ sessions, depth }: { sessions: SessionEntry[]; depth: number }) {
  return (
    <>
      {families(sessions).map((f) => (
        <div key={f.root.name}>
          <SessionRow s={f.root} depth={depth} />
          {f.branches.map((b) => (
            <SessionRow key={b.name} s={b} depth={depth + 1} branch />
          ))}
        </div>
      ))}
    </>
  );
}

let dragging: Drag | null = null;
function startDrag(e: DragEvent, d: Drag) {
  dragging = d;
  e.dataTransfer.setData('application/x-patter', JSON.stringify(d));
  e.dataTransfer.effectAllowed = 'move';
  e.stopPropagation();
}

/** Drop handlers for a row that takes `accepts`, highlighted while something it takes is over it. */
function useDrop(accepts: (d: Drag) => boolean, onDrop: (d: Drag) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!dragging || !accepts(dragging)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false);
        const d = dragging;
        dragging = null;
        if (!d || !accepts(d)) return;
        e.preventDefault();
        e.stopPropagation();
        onDrop(d);
      },
    },
  };
}

function Folder({ id, depth, icon, name, count, kind, folded, onToggle, add, items, drop, drag, children }: {
  id: string; depth: number; icon: string; name: string; count: string; kind: 'song' | 'set'; folded: boolean; onToggle: () => void;
  add: { title: string; run: () => unknown }; items: () => MenuItem[]; drop: ReturnType<typeof useDrop>; drag?: Drag; children: ReactNode;
}) {
  return (
    <div className="nav-folder">
      <div
        className={`nav-row folder ${kind}${drop.over ? ' drop' : ''}`}
        style={pad(depth)}
        onClick={onToggle}
        onDoubleClick={() => app.showDialog({ kind: 'rename', entry: { type: kind, id } })}
        draggable={Boolean(drag)}
        onDragStart={drag ? (e) => startDrag(e, drag) : undefined}
        {...drop.props}
      >
        <span className="nav-caret">{folded ? '▸' : '▾'}</span>
        <span className="nav-icon">{icon}</span>
        <span className="nav-name">{name}</span>
        <span className="nav-meta">{count}</span>
        <button
          className="nav-btn"
          title={add.title}
          onClick={(e) => {
            e.stopPropagation();
            void Promise.resolve(add.run()).catch((err) => app.showToast((err as Error).message, { error: true }));
          }}
        >
          ＋
        </button>
        <More title={`${kind}…`} items={items} />
      </div>
      {!folded && children}
    </div>
  );
}

function SongFolder({ song, depth, sessions, folded, toggle }: { song: SongEntry; depth: number; sessions: SessionEntry[]; folded: Set<string>; toggle: (id: string) => void }) {
  const mine = sessions.filter((s) => s.songId === song.id);
  const drop = useDrop(
    (d) => d.type === 'session' || (d.type === 'song' && d.id !== song.id),
    (d) => {
      if (d.type === 'session') app.moveSession(d.id, song.id);
      else app.moveSong(d.id, song.setId, app.tree.songs.filter((x) => x.setId === song.setId && x.id !== d.id).findIndex((x) => x.id === song.id));
    },
  );
  const sets = app.tree.sets;
  return (
    <Folder
      id={song.id}
      depth={depth}
      icon="♫"
      name={song.name}
      count={mine.length ? String(mine.length) : ''}
      kind="song"
      folded={folded.has(song.id)}
      onToggle={() => toggle(song.id)}
      drop={drop}
      drag={{ type: 'song', id: song.id }}
      add={{ title: 'new session in this song', run: () => app.newSession(song.id) }}
      items={() => [
        { label: 'New session here', run: () => app.newSession(song.id) },
        { label: 'Edit AGENTS.md…', run: () => app.showDialog({ kind: 'context', level: 'song', id: song.id }) },
        { label: 'Rename…', run: () => app.showDialog({ kind: 'rename', entry: { type: 'song', id: song.id } }) },
        {
          label: 'Move to set',
          pick: [
            ...sets.map((x) => ({ label: `◇ ${x.name}`, run: () => app.moveSong(song.id, x.id), current: x.id === song.setId })),
            { label: '— on its own (no set)', run: () => app.moveSong(song.id, null), current: song.setId === null },
          ],
        },
        { label: 'Delete…', run: () => app.showDialog({ kind: 'delete', entry: { type: 'song', id: song.id } }), danger: true },
      ]}
    >
      <FileRow level="song" id={song.id} depth={depth + 1} />
      <Family sessions={mine} depth={depth + 1} />
      {!mine.length && (
        <div className="nav-row hint" style={pad(depth + 1)}>
          drop sessions here, or ＋
        </div>
      )}
    </Folder>
  );
}

function SetFolder({ set, sessions, folded, toggle }: { set: SetEntry; sessions: SessionEntry[]; folded: Set<string>; toggle: (id: string) => void }) {
  const songs = app.tree.songs.filter((s) => s.setId === set.id);
  const drop = useDrop((d) => d.type === 'song', (d) => app.moveSong(d.id, set.id));
  return (
    <Folder
      id={set.id}
      depth={0}
      icon="◇"
      name={set.name}
      count={songs.length ? String(songs.length) : ''}
      kind="set"
      folded={folded.has(set.id)}
      onToggle={() => toggle(set.id)}
      drop={drop}
      add={{ title: 'new song in this set', run: () => app.showDialog({ kind: 'create', type: 'song', setId: set.id }) }}
      items={() => [
        { label: 'New song here…', run: () => app.showDialog({ kind: 'create', type: 'song', setId: set.id }) },
        { label: 'Edit AGENTS.md…', run: () => app.showDialog({ kind: 'context', level: 'set', id: set.id }) },
        { label: 'Rename…', run: () => app.showDialog({ kind: 'rename', entry: { type: 'set', id: set.id } }) },
        { label: 'Delete…', run: () => app.showDialog({ kind: 'delete', entry: { type: 'set', id: set.id } }), danger: true },
      ]}
    >
      <FileRow level="set" id={set.id} depth={1} />
      {songs.map((song) => (
        <SongFolder key={song.id} song={song} depth={1} sessions={sessions} folded={folded} toggle={toggle} />
      ))}
      {!songs.length && (
        <div className="nav-row hint" style={pad(1)}>
          drop songs here, or ＋
        </div>
      )}
    </Folder>
  );
}

// ── the navigator ───────────────────────────────────────────────────────────

/** The current session, even before the library lists it. */
function withCurrent(sessions: SessionEntry[]): SessionEntry[] {
  if (sessions.some((s) => s.name === app.session)) return sessions;
  const now = Date.now();
  return [
    { name: app.session, title: app.runtime.doc.title, songId: null, parent: null, forkAt: null, forkKeep: null, prefix: 0, modules: Object.keys(app.runtime.doc.modules).length, turns: app.turns, created: now, updated: now },
    ...sessions,
  ];
}

export function Navigator() {
  useEmitter(app.uiEvents);
  useEmitter(app.patchEvents);
  const [filter, setFilter] = useState('');
  const [folded, setFolded] = useState(loadFolded);
  const search = useRef<HTMLInputElement>(null);
  const tree = app.tree;
  const sessions = withCurrent(visibleSessions(tree, app.session));
  const loose = sessions.filter((s) => s.songId === null);
  const standalone = tree.songs.filter((s) => s.setId === null);
  const top = useDrop(
    (d) => (d.type === 'session' ? sessions.find((s) => s.name === d.id)?.songId !== null : tree.songs.find((s) => s.id === d.id)?.setId !== null),
    (d) => (d.type === 'session' ? app.moveSession(d.id, null) : app.moveSong(d.id, null)),
  );

  useEffect(() => {
    app.focusLibrarySearch = () => search.current?.focus();
    return () => {
      app.focusLibrarySearch = () => {};
    };
  }, []);

  const toggle = (id: string) => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  };

  const f = filter.trim().toLowerCase();
  const where = (s: SessionEntry) => {
    const song = tree.songs.find((x) => x.id === s.songId);
    const set = song?.setId ? tree.sets.find((x) => x.id === song.setId) : null;
    return song ? `${set ? `${set.name} / ` : ''}${song.name}` : '';
  };

  return (
    <nav className="navigator" aria-label="library">
      <div className="nav-head">
        <button className="nav-new" title="a new session with an empty patch, on its own (file it later)" onClick={() => void app.newSession(null)}>
          ＋ New session
        </button>
        <button className="nav-btn" title="new song" onClick={() => app.showDialog({ kind: 'create', type: 'song' })}>
          ♫＋
        </button>
        <button className="nav-btn" title="new set" onClick={() => app.showDialog({ kind: 'create', type: 'set' })}>
          ◇＋
        </button>
      </div>
      <input ref={search} className="nav-search" value={filter} placeholder="find a session (⌘O)" onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} />
      {app.treeError && <div className="nav-row hint error">{app.treeError}</div>}
      <div className="nav-tree">
        {f ? (
          sessions
            .filter((s) => (s.name === app.session ? app.runtime.doc.title : s.title).toLowerCase().includes(f) || where(s).toLowerCase().includes(f))
            .map((s) => <SessionRow key={s.name} s={s} depth={0} where={where(s)} />)
        ) : (
          <>
            <FileRow level="person" depth={0} />
            {tree.sets.map((set) => (
              <SetFolder key={set.id} set={set} sessions={sessions} folded={folded} toggle={toggle} />
            ))}
            {standalone.map((song) => (
              <SongFolder key={song.id} song={song} depth={0} sessions={sessions} folded={folded} toggle={toggle} />
            ))}
            <div className={`nav-section${top.over ? ' drop' : ''}`} {...top.props} title="sessions on their own; drop one here to take it out of its song">
              sessions
            </div>
            <div {...top.props} className="nav-loose">
              <Family sessions={loose} depth={0} />
              {!loose.length && <div className="nav-row hint">none on their own</div>}
            </div>
          </>
        )}
      </div>
    </nav>
  );
}

export type { Entry };
