// The library as a tree: where a session lives, what context it reads, which
// sessions are branches of which, and which ones a ‹ n/m › flips between.
// Pure functions over the library listing (the navigator and the chat use them).

import type { AgentContext } from '../agent/prompt';
import type { LibraryTree, SessionEntry, SongEntry, SetEntry } from './library';

export const UNTITLED = 'untitled patch';

export function songOf(tree: LibraryTree, session: string): SongEntry | null {
  const s = tree.sessions.find((x) => x.name === session);
  return (s?.songId && tree.songs.find((x) => x.id === s.songId)) || null;
}

export function setOf(tree: LibraryTree, song: SongEntry | null): SetEntry | null {
  return (song?.setId && tree.sets.find((x) => x.id === song.setId)) || null;
}

/** What a session's agent reads: its place, its song's and set's AGENTS.md, yours. */
export function contextOf(tree: LibraryTree, session: string): AgentContext {
  const song = songOf(tree, session);
  const set = setOf(tree, song);
  const siblings = song
    ? tree.sessions.filter((x) => x.songId === song.id && x.name !== session && x.title !== UNTITLED).map((x) => x.title).slice(0, 20)
    : [];
  return {
    agents: tree.agents,
    set: set ? { name: set.name, agents: set.agents } : null,
    song: song ? { name: song.name, agents: song.agents } : null,
    ...(siblings.length ? { siblings } : {}),
  };
}

const branched = (s: SessionEntry) => s.forkKeep === 'before' || s.forkKeep === 'after';

/**
 * The sessions that share `session`'s conversation before message `index`
 * and go different ways from there (it among them), oldest first: what the
 * ‹ n/m › at that message flips between. Empty when nothing branched there.
 */
export function branchesAt(sessions: SessionEntry[], session: string, index: number): string[] {
  const byName = new Map(sessions.map((s) => [s.name, s]));
  if (!byName.has(session)) return [];
  const members = new Set([session]);
  const queue = [session];
  while (queue.length) {
    const s = byName.get(queue.pop()!)!;
    // Up: it left its parent at this message.
    if (branched(s) && s.prefix === index && s.parent && byName.has(s.parent) && !members.has(s.parent)) {
      members.add(s.parent);
      queue.push(s.parent);
    }
    // Down: branches that left it at this message.
    for (const c of sessions) {
      if (c.parent === s.name && branched(c) && c.prefix === index && !members.has(c.name)) {
        members.add(c.name);
        queue.push(c.name);
      }
    }
  }
  if (members.size < 2) return [];
  return [...members].map((n) => byName.get(n)!).sort((a, b) => a.created - b.created).map((s) => s.name);
}

/**
 * Sessions grouped into families for the navigator: each session under the
 * oldest ancestor it shares a container (a song, or the top level) with.
 */
export function families(sessions: SessionEntry[]): { root: SessionEntry; branches: SessionEntry[] }[] {
  const byName = new Map(sessions.map((s) => [s.name, s]));
  const rootOf = (s: SessionEntry): SessionEntry => {
    let r = s;
    const seen = new Set<string>();
    for (let p = r.parent ? byName.get(r.parent) : undefined; p && p.songId === s.songId && !seen.has(p.name); p = p.parent ? byName.get(p.parent) : undefined) {
      seen.add(p.name);
      r = p;
    }
    return r;
  };
  const groups = new Map<string, { root: SessionEntry; branches: SessionEntry[] }>();
  for (const s of sessions) {
    const root = rootOf(s);
    const g = groups.get(root.name) ?? { root, branches: [] };
    if (root !== s) g.branches.push(s);
    groups.set(root.name, g);
  }
  for (const g of groups.values()) g.branches.sort((a, b) => a.created - b.created);
  // Families by their latest activity.
  const latest = (g: { root: SessionEntry; branches: SessionEntry[] }) => Math.max(g.root.updated, ...g.branches.map((b) => b.updated));
  return [...groups.values()].sort((a, b) => latest(b) - latest(a));
}

/** The navigator leaves out sessions nobody used (no title, no modules, never spoken to, unfiled, not branched), except the current one. */
export function visibleSessions(tree: LibraryTree, current: string): SessionEntry[] {
  const parents = new Set(tree.sessions.map((s) => s.parent).filter(Boolean));
  return tree.sessions.filter(
    (s) => s.name === current || s.songId !== null || s.modules > 0 || s.turns > 0 || s.title !== UNTITLED || parents.has(s.name) || s.parent !== null,
  );
}

export function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d}d` : new Date(t).toLocaleDateString();
}

/** A title from the first thing said in a session, for one nobody has named. */
export function titleFrom(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  let t = '';
  for (const w of words) {
    if ((t + ' ' + w).trim().length > 40) break;
    t = (t + ' ' + w).trim();
  }
  return (t || words[0]?.slice(0, 40) || UNTITLED).replace(/[.,;:!?]+$/, '');
}
