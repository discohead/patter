// The Samples interface in headless Chromium against the dev server: adding
// from the Samples tab, the loop view's moving playhead, dropping a file
// (which goes to the library in R2), and a reload bringing it back.
//   node scripts/smoke-samples-ui.mjs [url] [screenshot-dir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:5317/';
const shots = process.argv[3] ?? 'test-results/samples-ui';
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
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
      return runTool(n, i, { runtime: p.runtime, seq: p.seq, engine: p.engine });
    },
    [name, input],
  );
const start = async () => {
  await page.getByRole('button', { name: /start audio/ }).click();
  await page.waitForFunction(() => window.patter?.state === 'ready', null, { timeout: 30000 });
};

await page.goto(url);
await start();
const session = await page.evaluate(() => window.patter.session);

// Add from the Samples tab.
await page.getByRole('button', { name: /^Samples/ }).click();
await page.locator('.add-sample .chip', { hasText: /^loop$/ }).click();
await page.locator('.stock-names button', { hasText: /amen$/ }).first().click();
await page.waitForFunction(() => Boolean(window.patter.runtime.doc.samples.loop_amen), null, { timeout: 10000 }).catch(() => {});
check('the Samples tab adds from the pack', await page.evaluate(() => window.patter.runtime.doc.samples.loop_amen?.beats === 4));
await page.waitForTimeout(300);
await page.screenshot({ path: join(shots, '1-samples-tab.png') });

// A looper, selected: its waveform, loop region and playhead.
await tool('define_module', {
  name: 'loop',
  kind: 'audio',
  code: "QLoop.ar(sample('loop_amen'), { start: param('start', 1, [0, 3.75, 'lin', 0.25]), length: param('length', 2, [0.25, 4, 'exp']), rate: param('rate', 1, [0, 2, 'lin', 0.25]) }) * 0.7",
});
await page.locator('g.node').filter({ has: page.locator('title', { hasText: /^loop( —|$)/ }) }).first().click();
await page.waitForTimeout(700);
await page.screenshot({ path: join(shots, '2-loop-view.png') });
const playheads = await page.evaluate(async () => {
  const p = window.patter;
  const id = p.runtime.module('loop').meterId;
  const out = [];
  for (let i = 0; i < 3; i++) {
    out.push(p.engine.playheads.get(id)?.pos);
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
});
check('the loop view has a moving playhead inside the loop region', playheads.every((x) => x >= 1 && x < 3) && new Set(playheads.map((x) => x.toFixed(2))).size === 3, playheads.map((x) => x?.toFixed(2)).join(' '));
check('the loop view is drawn', await page.locator('.loop-view canvas').count() === 1);

// Drop a file on the page: it joins the patch and the library.
await page.evaluate(async () => {
  const bytes = await (await fetch('/samples/elec_ping.flac')).arrayBuffer();
  const file = new File([bytes], 'My Ping (take 2).flac', { type: 'audio/flac' });
  const dt = new DataTransfer();
  dt.items.add(file);
  for (const type of ['dragenter', 'dragover', 'drop']) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await page.waitForFunction(() => Boolean(window.patter.runtime.doc.samples.my_ping_take_2), null, { timeout: 10000 }).catch(() => {});
const dropped = await page.evaluate(() => window.patter.runtime.doc.samples.my_ping_take_2);
check('a dropped file becomes a patch sample, named from the file', dropped?.src?.startsWith('lib:') && dropped.file === 'My Ping (take 2).flac', JSON.stringify(dropped));
// The upload follows the sample into the patch: give it a moment.
let lib = [];
for (let i = 0; i < 20 && !lib.some((x) => `lib:${x.hash}` === dropped?.src); i++) {
  lib = await page.evaluate(async () => (await fetch('/api/samples')).json());
  if (!lib.some((x) => `lib:${x.hash}` === dropped?.src)) await page.waitForTimeout(250);
}
check('and is saved in the library (R2)', lib.some((x) => `lib:${x.hash}` === dropped?.src && x.name === 'My Ping (take 2).flac' && x.channels > 0), JSON.stringify(lib.map((x) => x.name)));
const told = await page.evaluate(() => window.patter.recentActions().join(' | '));
check('the agent will be told', /added the sample 'my_ping_take_2'/.test(told), told);
await page.screenshot({ path: join(shots, '3-dropped.png') });

// A reload brings the dropped sample back from the library.
await tool('define_module', { name: 'ping', kind: 'voice', code: "OneShot.ar(sample('my_ping_take_2'))" });
await page.waitForFunction(() => window.patter.autosave === 'saved', null, { timeout: 5000 }).catch(() => {});
await page.reload();
await start();
await page.waitForTimeout(500);
const back = await page.evaluate(() => ({ s: Object.keys(window.patter.runtime.doc.samples).sort().join(','), loaded: window.patter.bank.all().map((x) => x.src.slice(0, 10)), ping: Boolean(window.patter.runtime.module('ping')) }));
check('after a reload the samples (stock and library) come back, and what plays them', back.s === 'loop_amen,my_ping_take_2' && back.loaded.length === 2 && back.ping, JSON.stringify(back));

console.log('\npage errors:', logs.slice(0, 5));
console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
await browser.close();
const del = (path) => fetch(new URL(`/api/${path}`, url), { method: 'DELETE', headers: { 'x-patter': '1' } }).catch(() => {});
await del(`sessions/${session}`);
if (dropped?.src) await del(`samples/${dropped.src.slice(4)}`);
process.exit(failures ? 1 : 0);
