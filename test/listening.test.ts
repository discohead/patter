import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { NOTHING_ON_AIR, type OnAirStatus } from '../src/app/on-air';
import { Radio } from '../src/app/radio';
import { roleOf } from '../src/app/role';
import { compactTranscript, settled } from '../src/app/transcript';
import { emptyPatch, type PatchDoc } from '../src/runtime/patch';

describe('whose page it is', () => {
  const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  it("is the host's only when /whoami says so", async () => {
    expect(await roleOf({ search: '' }, answer({ host: true }))).toBe('host');
    expect(await roleOf({ search: '' }, answer({ host: false }))).toBe('listener');
    expect(await roleOf({ search: '' }, answer({ host: 'yes' }))).toBe('listener');
  });

  it("is a listener's when in doubt: no answer, an error, or a page that isn't JSON", async () => {
    expect(await roleOf({ search: '' }, answer({ host: true }, 500))).toBe('listener');
    expect(await roleOf({ search: '' }, async () => new Response('<html>sign in</html>'))).toBe('listener');
    expect(
      await roleOf({ search: '' }, async () => {
        throw new TypeError('offline');
      }),
    ).toBe('listener');
  });

  it("is a listener's with ?listen, without asking (how the host sees what listeners see)", async () => {
    let asked = false;
    const ask = async () => {
      asked = true;
      return new Response(JSON.stringify({ host: true }));
    };
    expect(await roleOf({ search: '?listen' }, ask)).toBe('listener');
    expect(await roleOf({ search: '?a=1&listen=1' }, ask)).toBe('listener');
    expect(asked).toBe(false);
  });
});

// ── the radio, with a stand-in for the page it plays in ──

const titled = (title: string): PatchDoc => ({ ...emptyPatch(), title });
const status = (over: Partial<OnAirStatus> = {}): OnAirStatus => ({ ...NOTHING_ON_AIR, live: true, session: 's-one', title: 'dub', since: 1, updatedAt: 1, ...over });

function tuned() {
  const played: string[] = [];
  const transport: boolean[] = [];
  let gate: (() => void) | null = null;
  const radio = new Radio({
    play: async (doc) => {
      played.push(doc.title);
      if (doc.title.startsWith('slow')) await new Promise<void>((r) => (gate = r));
    },
    transport: (stopped) => transport.push(stopped),
    changed: () => {},
  });
  return { radio, played, transport, open: () => gate?.() };
}
const patch = (title: string, updatedAt: number) => ({ type: 'patch' as const, session: 's-one', doc: titled(title), updatedAt });
/** Let what's queued go in. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the radio', () => {
  it('holds the patch until audio runs, then plays each change as it comes', async () => {
    const { radio, played } = tuned();
    radio.receive({ type: 'status', status: status() });
    radio.receive(patch('a', 1));
    expect(played).toEqual([]);
    await radio.start();
    radio.receive(patch('b', 2));
    await settle();
    expect(played).toEqual(['a', 'b']);
    expect(radio.behind).toBe(false);
  });

  it('plays one patch at a time, and of the ones that arrive meanwhile only the newest', async () => {
    const { radio, played, open } = tuned();
    await radio.start();
    radio.receive(patch('slow', 1));
    await settle();
    radio.receive(patch('b', 2));
    radio.receive(patch('c', 3));
    radio.receive(patch('d', 4));
    await settle();
    expect(played).toEqual(['slow']);
    open();
    await settle();
    expect(played).toEqual(['slow', 'd']);
    expect(radio.behind).toBe(false);
  });

  it("doesn't play the same patch again when a reconnect sends it", async () => {
    const { radio, played } = tuned();
    await radio.start();
    radio.receive(patch('a', 7));
    await settle();
    radio.receive(patch('a', 7));
    await settle();
    expect(played).toEqual(['a']);
  });

  it('detached, keeps its own patch and counts what it missed; rejoining brings the newest', async () => {
    const { radio, played, transport } = tuned();
    radio.receive({ type: 'status', status: status() });
    await radio.start();
    radio.receive(patch('a', 1));
    await settle();
    await radio.follow(false);
    radio.receive(patch('b', 2));
    radio.receive(patch('c', 3));
    radio.receive({ type: 'status', status: status({ stopped: true }) });
    expect(played).toEqual(['a']);
    expect(radio.missed).toBe(2);
    expect(radio.behind).toBe(true);
    expect(transport).toEqual([]);
    await radio.follow(true);
    expect(played).toEqual(['a', 'c']);
    expect(radio.missed).toBe(0);
    expect(transport).toEqual([true]); // and the host's transport, as it is now
  });

  it("follows the host's transport when it changes, not on every status", async () => {
    const { radio, transport } = tuned();
    radio.receive({ type: 'status', status: status() });
    await radio.start();
    radio.receive({ type: 'status', status: status({ updatedAt: 5 }) });
    radio.receive({ type: 'status', status: status({ stopped: true }) });
    radio.receive({ type: 'status', status: status({ stopped: true, updatedAt: 9 }) });
    radio.receive({ type: 'status', status: status({ stopped: false }) });
    expect(transport).toEqual([true, false]);
  });

  it('shows the conversation as it is sent', () => {
    const { radio } = tuned();
    const messages = [{ id: 'm1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'darker' }] }];
    radio.receive({ type: 'transcript', session: 's-one', messages });
    expect(radio.transcript).toEqual(messages);
  });
});

describe('the conversation, for listeners', () => {
  const said = (messages: unknown[]) => messages as UIMessage[];

  it('keeps what was said and what the tools did, not the patch state or the reasoning', () => {
    const out = compactTranscript(
      said([
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'two saws into a ladder' }, { type: 'text', text: '<patch_state>{"modules":{}}</patch_state>' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'thinking about Moogs' },
            { type: 'text', text: 'Building it.' },
            { type: 'tool-define_module', toolCallId: 't1', state: 'output-available', input: { name: 'osc' }, output: 'osc: audio, 2 ch' },
            { type: 'tool-modulate', toolCallId: 't2', state: 'output-available', input: { routes: [{ source: 'lfo', target: 'filter.cutoff' }] }, output: 'ERROR: no module lfo' },
            { type: 'tool-listen', toolCallId: 't3', state: 'input-available', input: { module: 'filter' } },
          ],
        },
        { id: 'sys', role: 'system', parts: [{ type: 'text', text: 'hidden' }] },
      ]),
    );
    expect(out).toEqual([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'two saws into a ladder' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Building it.' },
          { type: 'tool', name: 'define_module', subject: 'osc', state: 'ok', result: 'osc: audio, 2 ch' },
          { type: 'tool', name: 'modulate', subject: 'lfo→filter.cutoff', state: 'error', result: 'ERROR: no module lfo' },
          { type: 'tool', name: 'listen', subject: 'filter', state: 'stopped' },
        ],
      },
    ]);
  });

  it('counts a turn as over when every tool call has its answer, or was stopped', () => {
    const turn = (state: string) => said([{ id: 'a1', role: 'assistant', parts: [{ type: 'tool-listen', toolCallId: 't1', state }] }]);
    expect(settled(turn('output-available'), new Set())).toBe(true);
    expect(settled(turn('input-available'), new Set())).toBe(false);
    expect(settled(turn('input-available'), new Set(['t1']))).toBe(true);
    expect(settled(said([]), new Set())).toBe(true);
  });
});
