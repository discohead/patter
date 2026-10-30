import { beforeEach, describe, expect, it } from 'vitest';
import { cleanTranscript, librarySamples, MAX_TRANSCRIPT_CHARS, OnAirState, type OnAirKey, type OnAirMessage, type OnAirResult } from '../src/app/on-air';
import { emptyPatch, type PatchDoc } from '../src/runtime/patch';

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function patch(samples: Record<string, string> = {}): PatchDoc {
  const doc = emptyPatch();
  doc.title = 'dub chords';
  for (const [name, src] of Object.entries(samples)) doc.samples[name] = { src, channels: 2, frames: 48000, duration: 1 };
  return doc;
}

const read = (messages: string[]) => messages.map((m) => JSON.parse(m) as OnAirMessage);
const sent = (r: OnAirResult) => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return read(r.messages);
};

let rows: Map<OnAirKey, string>;
let air: OnAirState;

beforeEach(() => {
  rows = new Map();
  air = new OnAirState({ get: (k) => rows.get(k) ?? null, put: (k, v) => void rows.set(k, v) });
});

const goLive = (publisher = 'tab-aaaaaaaa', at = 1000) =>
  air.publish({ publisher, live: true, session: 's-one', title: 'dub chords', doc: patch({ loop: `lib:${HASH}` }), transcript: [], bpm: 92, stopped: false }, 'owner-prefix', at);

describe('on air', () => {
  it('says nothing is on air until something has been', () => {
    expect(read(air.welcome())).toEqual([{ type: 'status', status: expect.objectContaining({ live: false, session: null }) }]);
    expect(air.snapshot()).toMatchObject({ doc: null, transcript: [] });
    expect(air.sampleOwner(HASH)).toBeNull();
  });

  it('going on air sends everything, and a listener who connects later gets the same', () => {
    const messages = sent(goLive());
    expect(messages.map((m) => m.type)).toEqual(['status', 'patch', 'transcript']);
    expect(messages[0]).toMatchObject({ status: { live: true, session: 's-one', title: 'dub chords', bpm: 92, since: 1000, updatedAt: 1000 } });
    expect(messages[1]).toMatchObject({ session: 's-one', doc: { title: 'dub chords' }, updatedAt: 1000 });
    expect(read(air.welcome())).toEqual(messages);
  });

  it('takes updates only from the tab on air, until another tab takes over', () => {
    goLive('tab-aaaaaaaa');
    expect(air.publish({ publisher: 'tab-bbbbbbbb', doc: patch() }, 'owner-prefix')).toEqual({ ok: false, reason: 'elsewhere' });
    expect(air.isPublisher('tab-aaaaaaaa')).toBe(true);
    sent(air.publish({ publisher: 'tab-bbbbbbbb', live: true }, 'owner-prefix'));
    expect(air.isPublisher('tab-bbbbbbbb')).toBe(true);
    expect(air.publish({ publisher: 'tab-aaaaaaaa', stopped: true }, 'owner-prefix')).toEqual({ ok: false, reason: 'elsewhere' });
  });

  it('sends only what changed', () => {
    goLive();
    const knob = patch({ loop: `lib:${HASH}` });
    knob.master.level = 0.5;
    expect(sent(air.publish({ publisher: 'tab-aaaaaaaa', doc: knob }, 'owner-prefix', 2000)).map((m) => m.type)).toEqual(['status', 'patch']);
    const stop = sent(air.publish({ publisher: 'tab-aaaaaaaa', stopped: true }, 'owner-prefix', 3000));
    expect(stop).toEqual([{ type: 'status', status: expect.objectContaining({ stopped: true, since: 1000, updatedAt: 3000 }) }]);
    const said = [{ id: 'm1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'darker' }] }];
    expect(sent(air.publish({ publisher: 'tab-aaaaaaaa', transcript: said }, 'owner-prefix'))[1]).toEqual({ type: 'transcript', session: 's-one', messages: said });
  });

  it('a new session starts with an empty conversation until its own arrives', () => {
    goLive();
    air.publish({ publisher: 'tab-aaaaaaaa', transcript: [{ id: 'm1', role: 'user', parts: [] }] }, 'owner-prefix');
    const messages = sent(air.publish({ publisher: 'tab-aaaaaaaa', session: 's-two', title: 'night drive', doc: patch() }, 'owner-prefix'));
    expect(messages.at(-1)).toEqual({ type: 'transcript', session: 's-two', messages: [] });
  });

  it('off air keeps the last of everything, and refuses updates until it goes on air again', () => {
    goLive();
    const off = sent(air.publish({ publisher: 'tab-cccccccc', live: false }, 'owner-prefix', 5000));
    expect(off).toEqual([{ type: 'status', status: expect.objectContaining({ live: false, session: 's-one', since: 5000 }) }]);
    expect(read(air.welcome()).map((m) => m.type)).toEqual(['status', 'patch', 'transcript']);
    expect(air.publish({ publisher: 'tab-aaaaaaaa', doc: patch() }, 'owner-prefix')).toEqual({ ok: false, reason: 'off' });
    expect(air.isPublisher('tab-aaaaaaaa')).toBe(false);
    expect(air.sampleOwner(HASH)).toBe('owner-prefix');
  });

  it('lets a listener have a library sample only while the patch on air plays it', () => {
    goLive();
    expect(air.sampleOwner(HASH)).toBe('owner-prefix');
    expect(air.sampleOwner(OTHER)).toBeNull();
    air.publish({ publisher: 'tab-aaaaaaaa', doc: patch({ hats: 'stock:drum_cymbal_closed', perc: `lib:${OTHER}` }) }, 'owner-prefix');
    expect(air.sampleOwner(HASH)).toBeNull();
    expect(air.sampleOwner(OTHER)).toBe('owner-prefix');
  });
});

describe('the shapes on the wire', () => {
  it('finds the library samples a patch plays, and nothing else', () => {
    expect(librarySamples(patch({ a: `lib:${HASH}`, b: 'stock:loop_amen', c: 'lib:../../etc/passwd', d: `lib:${HASH}` }))).toEqual(new Set([HASH]));
    expect(librarySamples(null)).toEqual(new Set());
  });

  it('keeps a conversation to known shapes and cuts it to size', () => {
    expect(cleanTranscript('hello')).toBeNull();
    expect(cleanTranscript([{ id: 'm1', role: 'system', parts: [] }])).toBeNull();
    expect(
      cleanTranscript([
        { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'ok' }, { type: 'tool', name: 'define_module', subject: 'osc', state: 'weird', result: 'x'.repeat(1000), extra: 1 }, { type: 'image' }] },
      ]),
    ).toEqual([{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'ok' }, { type: 'tool', name: 'define_module', subject: 'osc', state: 'ok', result: 'x'.repeat(240) }] }]);
    const long = Array.from({ length: 400 }, (_, i) => ({ id: `m${i}`, role: 'user', parts: [{ type: 'text', text: 'y'.repeat(8000) }] }));
    const kept = cleanTranscript(long)!;
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    expect(kept.at(-1)!.id).toBe('m399');
  });
});
