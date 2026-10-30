// Recording the mix and the Mixer, in headless Chromium against the dev server:
// ● REC by key from one bar line to another (whole bars, starting on the
// downbeat), ⌘. ending one off the grid, ⟲ capture, the WAV download, takes
// surviving a reload, and the Mixer's strips, fader, mute and solo.
//   node scripts/smoke-record.mjs [url] [screenshot-dir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:5317/';
const shots = process.argv[3] ?? 'test-results/record';
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const page = await context.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => m.type() === 'error' && logs.push(`[console] ${m.text()}`));
page.on('response', (r) => r.status() >= 400 && logs.push(`[http ${r.status()}] ${r.url()}`));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const tool = (name, input) =>
  page.evaluate(
    async ([n, i]) => {
      const { runTool } = await import('/src/agent/tools.ts');
      const p = window.patter;
      return runTool(n, i, { runtime: p.runtime, seq: p.seq, engine: p.engine, isStopped: () => p.stopped });
    },
    [name, input],
  );
const start = async () => {
  await page.getByRole('button', { name: /start audio/ }).click();
  await page.waitForFunction(() => window.patter?.state === 'ready', null, { timeout: 30000 });
};
const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

await page.goto(url);
await start();
const session = await page.evaluate(() => window.patter.session);
check('the tap is listening once audio runs', await until(() => window.patter.recorder.available && window.patter.recorder.tap.held > 0, null, 5000), await page.evaluate(() => window.patter.recorder.tap.error ?? ''));

// A click on every bar line, and a quiet hum.
await tool('define_module', { name: 'click', kind: 'audio', code: 'const ph = BeatPhase.ar(4); const hit = ph < Delay1.ar(ph); Decay2.ar(K2A.ar(0) + hit, 0.001, 0.03) * SinOsc.ar(1800) * 0.8' });
await tool('define_module', { name: 'hum', kind: 'audio', code: 'SinOsc.ar(110) * 0.05' });

// ── the mixer ──
await page.getByRole('button', { name: /^Mixer/ }).click();
await page.waitForTimeout(600);
const strips = await page.locator('.mixer .strip:not(.scale) .strip-name').allTextContents();
check('the Mixer has a strip per module that plays, then the master', strips.join(',') === 'click,hum,master', strips.join(','));
await page.screenshot({ path: join(shots, '1-mixer.png') });
const humStrip = page.locator('.strip').filter({ has: page.locator('.strip-name', { hasText: /^hum$/ }) });
const fader = humStrip.locator('.fader');
const box = await fader.boundingBox();
const cap = await humStrip.locator('.fader-cap').boundingBox();
await page.mouse.move(cap.x + cap.width / 2, cap.y + cap.height / 2);
await page.mouse.down();
await page.mouse.move(cap.x + cap.width / 2, cap.y + cap.height / 2 + 40, { steps: 5 });
await page.mouse.up();
const dragged = await page.evaluate(() => window.patter.runtime.doc.modules.hum.level);
check('dragging a fader down lowers the level', dragged < 0.5 && dragged > 0, `level ${dragged.toFixed(3)} (${(20 * Math.log10(dragged)).toFixed(1)} dB)`);
await fader.dblclick({ position: { x: box.width / 2, y: 5 } });
check('double-click puts it back at 0 dB', await page.evaluate(() => window.patter.runtime.doc.modules.hum.level === 1));
const told = await page.evaluate(() => window.patter.recentActions().join(' | '));
check('the agent hears about it', /mixer: hum at/.test(told), told);
await page.locator('.strip').filter({ has: page.locator('.strip-name', { hasText: /^click$/ }) }).locator('.ms.solo').click();
await page.waitForTimeout(300);
check('solo silences the other strips', await page.evaluate(() => window.patter.runtime.silenced('hum') && !window.patter.runtime.silenced('click')));
await page.screenshot({ path: join(shots, '2-solo.png') });
await page.locator('.strip').filter({ has: page.locator('.strip-name', { hasText: /^click$/ }) }).locator('.ms.solo').click();
await humStrip.locator('.ms.mute').click();
const mixState = await page.evaluate(() => ({ s: window.patter.runtime.soloing(), m: window.patter.runtime.doc.modules.hum.mute }));
check('unsolo, then mute', !mixState.s && mixState.m, JSON.stringify(mixState));
await humStrip.locator('.ms.mute').click();

// ── ● REC by key, bar line to bar line ──
await page.keyboard.press('Alt+KeyR');
const armed = await page.evaluate(() => window.patter.recorder.rec?.phase);
check('⌥R arms a recording', armed === 'armed' || armed === 'recording', armed);
check('it starts on a bar line', await until(() => window.patter.recorder.rec?.phase === 'recording', null, 6000));
await page.screenshot({ path: join(shots, '3-recording.png') });
await page.waitForTimeout(4500);
await page.keyboard.press('Alt+KeyR');
check('⌥R again waits for the next bar line', await page.evaluate(() => ['finishing', 'saving'].includes(window.patter.recorder.rec?.phase) || window.patter.recorder.takes.length > 0));
check('then the take is done', await until(() => !window.patter.recorder.rec && window.patter.recorder.takes.length === 1, null, 8000));
const rec = await page.evaluate(async () => {
  const p = window.patter;
  const take = p.recorder.takes[0];
  const buf = await (await p.recorder.wav(take)).arrayBuffer();
  const audio = await new OfflineAudioContext(2, 1, take.sampleRate).decodeAudioData(buf);
  const x = audio.getChannelData(0);
  // Onsets: the first sample over 0.1 after 20 ms of quiet.
  const hits = [];
  let quiet = 0;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > 0.1) {
      if (quiet > take.sampleRate * 0.02 || hits.length === 0) hits.push(i);
      quiet = 0;
    } else quiet++;
  }
  const bar = (4 * 60) / take.bpm;
  return { frames: take.frames, bars: take.bars, bpm: take.bpm, sr: take.sampleRate, decoded: audio.length, hitsInBars: hits.map((i) => Math.round((i / take.sampleRate / bar) * 1000) / 1000), barSeconds: bar };
});
console.log('  take:', JSON.stringify(rec));
check('the take is whole bars long', rec.bars >= 2 && Math.abs(rec.frames - rec.bars * rec.barSeconds * rec.sr) <= 1 && rec.decoded === rec.frames, `${rec.bars} bars, ${rec.frames} frames`);
check('and starts on the downbeat: the bar clicks are at 0, 1, 2… bars', rec.hitsInBars.length === rec.bars && rec.hitsInBars.every((b, i) => Math.abs(b - i) < 0.01), JSON.stringify(rec.hitsInBars));
check('a note pops up to download it', await page.locator('.toast').filter({ hasText: /Recorded \d+ bars/ }).isVisible());
const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.toast button', { hasText: 'WAV' }).click()]);
const file = download.suggestedFilename();
const size = (await download.createReadStream().then((s) => new Promise((resolve) => { let n = 0; s.on('data', (c) => (n += c.length)); s.on('end', () => resolve(n)); })));
check('⬇ WAV downloads the 24-bit file', /\.wav$/.test(file) && size === 44 + rec.frames * 6, `${file}, ${size} bytes`);

// ⌘. ends a recording where it is.
await page.keyboard.press('Alt+KeyR');
await until(() => window.patter.recorder.rec?.phase === 'recording', null, 6000);
await page.waitForTimeout(1000);
await page.keyboard.press('Meta+Period');
check('⌘. ends a recording off the grid (not whole bars)', await until(() => !window.patter.recorder.rec && window.patter.recorder.takes.length === 2, null, 5000) && (await page.evaluate(() => window.patter.recorder.takes[0].bars === undefined && window.patter.recorder.takes[0].frames > 0)));
await page.keyboard.press('Meta+Period');
await page.waitForTimeout(1500);

// ── ⟲ capture ──
await page.keyboard.press('Alt+KeyC');
check('⌥C captures the last minutes', await until(() => window.patter.recorder.takes.some((t) => t.kind === 'capture'), null, 8000));
const cap1 = await page.evaluate(() => {
  const t = window.patter.recorder.takes.find((x) => x.kind === 'capture');
  return { seconds: t.frames / t.sampleRate, name: t.name };
});
const ranFor = await page.evaluate(() => window.patter.recorder.tap.held / window.patter.recorder.tap.sampleRate);
check('as much as the ring holds, less the silence before the first sound', cap1.seconds > 5 && cap1.seconds <= ranFor + 0.1, `${cap1.seconds.toFixed(1)} s of ${ranFor.toFixed(1)} s held`);
await page.getByRole('button', { name: /^Recordings/ }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: join(shots, '4-recordings.png') });
check('the Recordings tab lists the takes', (await page.locator('.take').count()) === 3);

// ── after a reload ──
await page.reload();
await page.getByRole('button', { name: /^Recordings/ }).click().catch(() => {});
const kept = await until(() => window.patter.recorder.takes.length === 3, null, 5000);
check('the takes are still there after a reload (this browser keeps them)', kept, await page.evaluate(() => window.patter.recorder.takes.map((t) => `${t.name} ${t.frames}`).join(', ')));
await start();
await page.getByRole('button', { name: /^Recordings/ }).click();
const toSample = await page.evaluate(async () => {
  const p = window.patter;
  const t = p.recorder.takes.find((x) => x.bars);
  const name = await p.takeToPatch(t.id);
  return { name, beats: p.runtime.doc.samples[name]?.beats, bars: t.bars };
});
check('a whole-bar take becomes a sample that knows its beats', toSample.name && toSample.beats === toSample.bars * 4, JSON.stringify(toSample));

console.log('\npage errors:', logs.slice(0, 6));
console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
// Tidy up: the takes, the sample's library copy, the session.
const libHashes = await page.evaluate(async () => {
  const p = window.patter;
  for (const t of [...p.recorder.takes]) await p.removeTake(t.id);
  return Object.values(p.runtime.doc.samples).map((s) => s.src).filter((s) => s.startsWith('lib:')).map((s) => s.slice(4));
});
await browser.close();
const del = (path) => fetch(new URL(`/api/${path}`, url), { method: 'DELETE', headers: { 'x-patter': '1' } }).catch(() => {});
await del(`sessions/${session}`);
for (const h of libHashes) await del(`samples/${h}`);
process.exit(failures ? 1 : 0);
