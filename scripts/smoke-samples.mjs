// Samples end to end in headless Chromium against the dev server: browse and
// add from Sonic Pi's pack, analysis, QLoop in tape and stretch modes (sound,
// playhead replies, a change landing on the beat), OneShot voices from a
// routine, and new audio under the same name without a restart.
//   node scripts/smoke-samples.mjs [url]
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:5317/';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const tool = async (name, input) => {
  const out = await page.evaluate(
    async ([n, i]) => {
      const { runTool } = await import('/src/agent/tools.ts');
      const p = window.patter;
      return runTool(n, i, { runtime: p.runtime, seq: p.seq, engine: p.engine, isStopped: () => p.stopped, record: (s, b, name) => p.record(s, b, name) });
    },
    [name, input],
  );
  if (out.isError) console.log(`  (${name} error: ${out.content.slice(0, 300)})`);
  return out;
};
const json = (out) => {
  try {
    return JSON.parse(out.content);
  } catch {
    return { raw: out.content };
  }
};

await page.goto(url);
await page.getByRole('button', { name: /start audio/ }).click();
await page.waitForFunction(() => window.patter?.state === 'ready', null, { timeout: 30000 });
const session = await page.evaluate(() => window.patter.session);

const cats = json(await tool('samples', { action: 'browse' }));
check('browse lists the stock pack by category', Array.isArray(cats.stock?.loop) && cats.stock.loop.includes('loop_amen'), Object.keys(cats.stock ?? {}).join(' '));

const added = json(await tool('samples', { action: 'add', name: 'amen', from: 'loop_amen' }));
console.log('  amen:', JSON.stringify(added).slice(0, 400));
check('add loads it and analyses it', added.channels >= 1 && added.duration > 1 && added.analysis?.kind === 'loop', `beats ${added.beats}, ${JSON.stringify(added.analysis?.tempo)}`);
const set = json(await tool('samples', { action: 'set', name: 'amen', beats: 4 }));
check('set gives it 4 beats', set.beats === 4);

const loopCode = `QLoop.ar(sample('amen'), {
  start: param('start', 0, [0, 3.75, 'lin', 0.25]),
  length: param('length', 4, [0.25, 4, 'exp']),
  rate: param('rate', 1, [0, 2, 'lin', 0.25]),
  reverse: param('reverse', 0, [0, 1, 'lin', 1]),
  quant: 1,
}) * 0.8`;
const def = json(await tool('define_module', { name: 'loop', kind: 'audio', code: loopCode }));
check('a QLoop module compiles', def.name === 'loop' && !def.raw, JSON.stringify(def).slice(0, 200));
await page.waitForTimeout(600);
const heard = json(await tool('listen', { module: 'loop', seconds: 1 }));
check('it sounds', heard.peakDb > -30, `peak ${heard.peakDb} dB, pulse ${heard.pulseHz}`);
const ph = await page.evaluate(() => {
  const m = window.patter.runtime.module('loop');
  const p = window.patter.engine.playheads.get(m.meterId);
  return p && { ...p, age: performance.now() - p.time };
});
check('it reports its playhead', ph && ph.age < 300 && ph.pos >= 0 && ph.pos < 4 && ph.length === 4 && ph.beats === 4, JSON.stringify(ph));

// The playhead is a function of the transport: compare with the clock (after the engine's clock is calibrated).
await page.evaluate(() => window.patter.engine.calibrateClock());
await page.waitForTimeout(300);
const sync = await page.evaluate(async () => {
  const p = window.patter;
  const m = p.runtime.module('loop');
  const out = [];
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 170));
    const h = p.engine.playheads.get(m.meterId);
    out.push({ pos: h.pos, beat: p.seq.beatNow() % 4 });
  }
  return out;
});
const err = sync.map((x) => Math.min(Math.abs(x.pos - x.beat), 4 - Math.abs(x.pos - x.beat)));
check('the playhead follows the transport beat', err.every((e) => e < 0.15), err.map((e) => e.toFixed(3)).join(' '));

// In the engine: a routine's event for beat b sees BeatPhase at b.
await tool('define_module', { name: 'probe', kind: 'control', code: "SendReply.kr(param('t_hit', 0), '/probe', [BeatPhase.kr(4)]); DC.kr(0)" });
await page.evaluate(() => { window.__hits = []; window.patter.engine.sonic.on('in', (m) => { if (m[0] === '/probe') window.__hits.push(m[3]); }); });
await tool('define_routine', { name: 'hits', code: "while (true) { set('probe', { t_hit: 1 }); yield 1; }", quant: 1 });
await page.waitForTimeout(3000);
await tool('routine_control', { name: 'hits', action: 'remove' });
const hits = await page.evaluate(() => window.__hits.slice(-4));
const off = hits.map((h) => { const f = h % 1; return Math.min(f, 1 - f); });
check('routine events land on whole beats of the engine clock', hits.length >= 3 && off.every((x) => x < 0.02), hits.map((h) => h.toFixed(3)).join(' '));
await tool('remove_module', { name: 'probe', force: true });

// Quantized: a rate change lands on the next beat, not before.
await tool('set_params', { updates: [{ target: 'loop.rate', value: 0.6 }] });
const atChange = await page.evaluate(() => {
  const p = window.patter;
  const h = p.engine.playheads.get(p.runtime.module('loop').meterId);
  return { rate: h.rate, frac: p.seq.beatNow() % 1 };
});
await page.waitForTimeout(1200);
const later = await page.evaluate(() => window.patter.engine.playheads.get(window.patter.runtime.module('loop').meterId).rate);
check('a rate change snaps to a quarter step and lands on the beat', later === 0.5, `rate right after: ${atChange.rate} (beat frac ${atChange.frac.toFixed(2)}), a beat later: ${later}`);

// Stretch mode: pitch on a scale, independent of time.
const stretch = json(
  await tool('define_module', {
    name: 'cloud',
    kind: 'audio',
    code: "QLoop.ar(sample('amen'), { rate: 0, start: 1, length: 1, pitch: param('pitch', 2, [-7, 7, 'lin', 1]), scale: [0, 2, 3.86, 5, 7.02, 8.84, 10], mode: 'stretch' }) * 0.5",
  }),
);
check('stretch mode with a microtonal scale compiles', stretch.name === 'cloud', (stretch.warnings ?? []).join('; '));
await page.waitForTimeout(500);
const cloud = json(await tool('listen', { module: 'cloud', seconds: 1 }));
check('a frozen stretch loop still sounds (a held cloud)', cloud.peakDb > -45, `peak ${cloud.peakDb} dB`);
await tool('remove_module', { name: 'cloud' });

// OneShot voices from a routine.
const kick = json(await tool('samples', { action: 'add', name: 'kick', from: 'bd_haus' }));
check('a one-shot is recognised as one', kick.analysis?.kind === 'one-shot', JSON.stringify(kick.analysis ?? {}).slice(0, 200));
await tool('define_module', { name: 'drum', kind: 'voice', code: "OneShot.ar(sample('kick'), { rate: param('rate', 1), amp: param('amp', 0.7) })" });
await tool('mix', { module: 'loop', play: false });
await tool('define_routine', { name: 'four', code: "while (true) { play('drum', { rate: 1 }); yield 1; }", quant: 0 });
await page.waitForTimeout(800);
const drum = json(await tool('listen', { module: 'drum', seconds: 2 }));
check('the routine plays the one-shot voice on every beat', drum.peakDb > -30 && Math.abs((drum.pulseHz ?? 0) - (await page.evaluate(() => window.patter.seq.bpm / 60))) < 0.4, `peak ${drum.peakDb} dB, pulse ${drum.pulseHz} Hz`);
const voices = await page.evaluate(() => window.patter.engine.sonic.getTree().root ? JSON.stringify(window.patter.engine.sonic.getTree()).match(/pm_/g)?.length : 0);
console.log('  synths in the tree:', voices);

// New audio under the same name: no restart.
await tool('mix', { module: 'loop', play: true });
const node = await page.evaluate(() => window.patter.runtime.module('loop').node);
const swapped = json(await tool('samples', { action: 'set', name: 'amen', from: 'loop_compus', beats: 16 }));
check('new audio under the same name', swapped.from === 'stock:loop_compus' && swapped.beats === 16, JSON.stringify(swapped).slice(0, 200));
check('reaches the running loop without a restart', (await page.evaluate(() => window.patter.runtime.module('loop').node)) === node);
await page.waitForTimeout(700);
const after = await page.evaluate(() => window.patter.engine.playheads.get(window.patter.runtime.module('loop').meterId));
check('and it now loops 16 beats of the new audio', after?.beats === 16, JSON.stringify(after));

const analysis = json(await tool('samples', { action: 'analyze', name: 'amen' }));
check('analyze reports onsets in beats once the beats are known', Array.isArray(analysis.analysis?.onsets?.beats), JSON.stringify(analysis.analysis?.onsets ?? {}).slice(0, 160));

// Slice and Grains sound.
await tool('define_module', { name: 'chops', kind: 'audio', code: "Slice.ar(sample('amen'), { index: Stepper.kr(Impulse.kr(4), 0, 0, 15), slices: 16, trig: Impulse.kr(4) }) * 0.6" });
await tool('define_module', { name: 'cloud', kind: 'audio', code: "Grains.ar(sample('amen'), { position: LFNoise1.kr(0.3).range(0.2, 0.8), density: 30, size: 0.08 })" });
await page.waitForTimeout(500);
const chops = json(await tool('listen', { module: 'chops', seconds: 1 }));
const grains = json(await tool('listen', { module: 'cloud', seconds: 1 }));
check('Slice chops and Grains clouds both sound', chops.peakDb > -30 && grains.peakDb > -40, `chops ${chops.peakDb} dB (pulse ${chops.pulseHz}), cloud ${grains.peakDb} dB`);
await tool('remove_module', { name: 'chops' });
await tool('remove_module', { name: 'cloud' });

// Record a beat-locked click for one bar: a perfect, beat-long loop comes back.
await tool('mix', { module: 'loop', play: false });
await tool('routine_control', { name: 'four', action: 'stop' });
await tool('define_module', { name: 'click', kind: 'audio', play: false, code: "const ph = BeatPhase.ar(1); const hit = ph < Delay1.ar(ph); Decay2.ar(K2A.ar(0) + hit, 0.001, 0.03) * SinOsc.ar(1800) * 0.8" });
const t0 = Date.now();
const rec = json(await tool('samples', { action: 'record', source: 'click', bars: 1 }));
console.log(`  recorded in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, JSON.stringify(rec).slice(0, 300));
const bpm = await page.evaluate(() => window.patter.seq.bpm);
check('record makes a sample exactly a bar long', rec.beats === 4 && Math.abs(rec.duration - (4 * 60) / bpm) < 0.002, `${rec.duration} s vs ${(4 * 60 / bpm).toFixed(4)} s`);
const recA = json(await tool('samples', { action: 'analyze', name: rec.name }));
const hitsAt = recA.analysis?.onsets?.beats ?? [];
check('the recording starts on the bar line: its clicks fall on the beats', hitsAt.length >= 4 && hitsAt.slice(0, 4).every((b, i) => Math.abs(b - i) < 0.03), JSON.stringify(hitsAt));
const inLib = await page.evaluate(async (src) => (await (await fetch('/api/samples')).json()).some((x) => `lib:${x.hash}` === src), rec.from);
check('the recording is saved to the library', inLib);
await tool('define_module', { name: 'reloop', kind: 'audio', code: `QLoop.ar(sample('${rec.name}'), { length: 1, rate: 2 }) * 0.5` });
await page.waitForTimeout(600);
const re = json(await tool('listen', { module: 'reloop', seconds: 1 }));
check('and QLoop plays the recording straight away', re.peakDb > -30, `peak ${re.peakDb} dB, pulse ${re.pulseHz} Hz`);
if (rec.from) await page.evaluate((h) => fetch(`/api/samples/${h}`, { method: 'DELETE', headers: { 'x-patter': '1' } }), rec.from.slice(4));

console.log('\nCONSOLE (errors/warnings):');
for (const l of logs.filter((l) => /error|warn/i.test(l)).slice(0, 20)) console.log(l);
console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
await browser.close();
await fetch(new URL(`/api/sessions/${session}`, url), { method: 'DELETE', headers: { 'x-patter': '1' } }).catch(() => {});
process.exit(failures ? 1 : 0);
