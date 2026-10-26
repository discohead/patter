// The agent across a reload and a stop, with the real model on the dev
// server: reload mid-turn (nothing may start audio by itself; waiting tool
// calls run once audio starts and the patch is back), then ⌘. mid-turn
// (the turn stops, and what it hadn't run never runs, even after a reload).
//   node scripts/smoke-resume.mjs [url]
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:5317/';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const state = () =>
  page.evaluate(() => ({
    state: window.patter.state,
    waiting: window.patter.waitingTools,
    modules: Object.keys(window.patter.runtime.doc.modules),
    done: document.querySelectorAll('.tool-ok, .tool-error').length,
    running: document.querySelectorAll('.tool-running').length,
    notRun: document.querySelectorAll('.tool-stopped').length,
    busy: !!document.querySelector('.chat .danger'),
  }));
const start = async () => {
  await page.getByRole('button', { name: /start audio/ }).click();
  await page.waitForFunction(() => ['ready', 'error'].includes(window.patter?.state), null, { timeout: 30000 });
};
const send = async (text) => {
  const input = page.locator('textarea.composer-input');
  await input.fill(text);
  await input.press('Enter');
};
const until = async (pred, ms, every = 500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await state();
    if (pred(s)) return s;
    await page.waitForTimeout(every);
  }
  return state();
};

await page.goto(url);
await start();
const session = await page.evaluate(() => window.patter.session);

// ── reload in the middle of a turn ───────────────────────────────────────────
await send('Build a patch of six separate modules, one tool call each: a slow sine LFO, two detuned saw oscillators, a resonant low-pass filter reading both, a VCA, and a reverb. Then listen.');
const mid = await until((s) => s.done >= 2, 120_000);
console.log('reloading mid-turn at', JSON.stringify(mid));
await page.reload();
await page.waitForTimeout(8000);
const after = await state();
check('after the reload nothing started audio by itself', after.state === 'off', JSON.stringify(after));
check('no boot error', !(await page.locator('.boot .error').count()));
if (after.waiting > 0) check('the start screen says the agent is waiting', /agent was in the middle/.test(await page.locator('.boot').innerText()), `${after.waiting} waiting`);
else console.log('note: no tool call was pending at the reload (the turn continues on the server)');
await start();
check('start audio works', (await page.evaluate(() => window.patter.state)) === 'ready');
const finished = await until((s) => !s.busy && s.running === 0 && s.waiting === 0, 180_000, 1500);
check('the turn carried on and built the patch', finished.modules.length >= 4, finished.modules.join(','));

// ── stop in the middle of a turn ─────────────────────────────────────────────
const before = (await state()).done;
await send('Now add three more modules, one at a time: a noise source, a band-pass filter on it, and a slow random LFO on that filter. Listen after each.');
await until((s) => s.done >= before + 1, 120_000);
await page.keyboard.press('Meta+.');
const stopped = await until((s) => !s.busy && s.running === 0, 20_000);
check('⌘. stops the turn and the sound', (await page.evaluate(() => window.patter.stopped)) && !stopped.busy, JSON.stringify(stopped));
const count = (await state()).modules.length;
await page.waitForTimeout(5000);
check('nothing else runs after the stop', (await state()).modules.length === count);
await page.reload();
await page.waitForTimeout(6000);
const re = await state();
check('after a reload, the stopped calls stay stopped', re.waiting === 0, JSON.stringify(re));
await start();
await page.waitForTimeout(3000);
check('and the patch is back, as it was', (await state()).modules.length === count);

console.log('page errors:', errors.slice(0, 5));
console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
await browser.close();
await fetch(new URL(`/api/sessions/${session}`, url), { method: 'DELETE', headers: { 'x-patter': '1' } }).catch(() => {});
process.exit(failures ? 1 : 0);
