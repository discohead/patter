import { describe, expect, it } from 'vitest';
import type { LibraryTree, SessionEntry } from '../src/app/library';
import { branchesAt, contextOf, families, titleFrom, visibleSessions } from '../src/app/tree';

let clock = 0;
function session(name: string, more: Partial<SessionEntry> = {}): SessionEntry {
  clock += 10;
  return { name, title: name, songId: null, parent: null, forkAt: null, forkKeep: null, prefix: 0, modules: 1, turns: 1, created: clock, updated: clock, ...more };
}

describe('branches', () => {
  // a: 6 messages. b: edited a's message 2 (keeps 2). c: went on from a's answer 3 (keeps 4).
  // d: edited b's message 2 again (keeps 2). e: a fresh start from a (no conversation).
  const a = session('a');
  const b = session('b', { parent: 'a', forkKeep: 'before', forkAt: 'm2', prefix: 2 });
  const c = session('c', { parent: 'a', forkKeep: 'after', forkAt: 'm3', prefix: 4 });
  const d = session('d', { parent: 'b', forkKeep: 'before', forkAt: 'n2', prefix: 2 });
  const e = session('e', { parent: 'a', forkKeep: 'none', prefix: 0 });
  const all = [a, b, c, d, e];

  it('flips between the sessions that go different ways from a message, oldest first', () => {
    expect(branchesAt(all, 'a', 2)).toEqual(['a', 'b', 'd']);
    expect(branchesAt(all, 'd', 2)).toEqual(['a', 'b', 'd']);
    expect(branchesAt(all, 'c', 4)).toEqual(['a', 'c']);
    expect(branchesAt(all, 'a', 4)).toEqual(['a', 'c']);
  });

  it('shows nothing where nothing branched, or for a fresh start', () => {
    expect(branchesAt(all, 'a', 0)).toEqual([]);
    expect(branchesAt(all, 'c', 2)).toEqual([]);
    expect(branchesAt(all, 'e', 0)).toEqual([]);
    expect(branchesAt(all, 'gone', 2)).toEqual([]);
  });

  it('puts branches under the oldest ancestor in the same place', () => {
    const inSong = session('f', { parent: 'a', forkKeep: 'all', songId: 'song-1' });
    const fams = families([...all, inSong]);
    const top = fams.find((x) => x.root.name === 'a')!;
    expect(top.branches.map((x) => x.name)).toEqual(['b', 'c', 'd', 'e']);
    expect(fams.find((x) => x.root.name === 'f')?.branches).toEqual([]);
  });
});

describe('the tree', () => {
  const tree: LibraryTree = {
    agents: 'I play live.',
    sets: [{ id: 'set-1', name: 'Warehouse', agents: '124–132 bpm', created: 1, updated: 1 }],
    songs: [{ id: 'song-1', name: 'Night Drive', setId: 'set-1', agents: 'D minor, 92 bpm', position: 0, created: 1, updated: 1 }],
    sessions: [
      session('in-song', { songId: 'song-1', title: 'bass' }),
      session('drums', { songId: 'song-1', title: 'drums' }),
      session('loose'),
      session('blank', { title: 'untitled patch', modules: 0, turns: 0 }),
    ],
  };

  it('gives a session its layers of context', () => {
    expect(contextOf(tree, 'in-song')).toEqual({
      agents: 'I play live.',
      set: { name: 'Warehouse', agents: '124–132 bpm' },
      song: { name: 'Night Drive', agents: 'D minor, 92 bpm' },
      siblings: ['drums'],
    });
    expect(contextOf(tree, 'loose')).toEqual({ agents: 'I play live.', set: null, song: null });
  });

  it('leaves out sessions nobody used, unless you are in one', () => {
    expect(visibleSessions(tree, 'loose').map((s) => s.name)).not.toContain('blank');
    expect(visibleSessions(tree, 'blank').map((s) => s.name)).toContain('blank');
  });

  it('names an untitled session after its first message', () => {
    expect(titleFrom('make a dub techno chord stab with a long tape delay and a little wow and flutter')).toBe('make a dub techno chord stab with a long');
    expect(titleFrom('  drone.  ')).toBe('drone');
  });
});
