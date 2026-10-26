// Sessions, the patch library and the transport, end to end in headless
// Chromium against the dev server: autosave and restore across a reload,
// ⌘. stop/play, save / save as / open / recent sessions / delete / import,
// clear and undo. Screenshots go to the given directory.
//   node scripts/smoke-library.mjs [url] [screenshot-dir]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:5317/';
const shots = process.argv[3] ?? 'test-results/library';
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const app = (fn, arg) => page.evaluate(fn, arg);
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
  await page.waitForFunction(() => window.patter?.state === 'ready' || window.patter?.state === 'error', null, { timeout: 30000 });
};
const modules = () => app(() => Object.keys(window.patter.runtime.doc.modules).sort().join(','));
const sessionsMade = new Set();
const NAME = `smoke library ${Date.now().toString(36)}`;
let savedId = null;
// After the browser closes (closing re-saves the open session): from here, not the page.
const tidy = async () => {
  const del = (path) => fetch(new URL(`/api/${path}`, url), { method: 'DELETE', headers: { 'x-patter': '1' } }).catch(() => {});
  for (const s of sessionsMade) await del(`sessions/${s}`);
  if (savedId) await del(`patches/${savedId}`);
};
process.on('uncaughtException', async (e) => {
  console.log(`FAIL crashed: ${e.message.split('\n')[0]}`);
  await browser.close();
  await tidy();
  process.exit(1);
});

await page.goto(url);
await start();
const first = await app(() => window.patter.session);
sessionsMade.add(first);

// ── autosave and restore ─────────────────────────────────────────────────────
await tool('define_module', { name: 'osc', kind: 'audio', play: false, code: "Saw.ar(param('freq', 110, 'freq')) * 0.15" });
await tool('define_module', { name: 'vca', kind: 'audio', code: "Pan2.ar(LPF.ar(input('osc'), param('cutoff', 1200, 'freq')), 0)" });
await tool('annotate', { title: 'library smoke' });
await page.waitForFunction(() => window.patter.autosave === 'saved', null, { timeout: 5000 }).catch(() => {});
const remote = await app(async (s) => (await fetch(`/api/sessions/${s}`)).json(), first);
check('the session autosaves to the server', Object.keys(remote.doc?.modules ?? {}).length === 2 && remote.doc.title === 'library smoke');

await page.reload();
await page.waitForFunction(() => window.patter?.resumes, null, { timeout: 5000 }).catch(() => {});
const startText = await page.locator('.boot').innerText();
check('the start screen says what it will pick up', /library smoke/.test(startText) && /2 modules/.test(startText), startText.split('\n')[1]);
await page.screenshot({ path: join(shots, '1-start-screen.png') });
check('nothing starts before the click', (await app(() => window.patter.state)) === 'off');
await start();
check('the patch is back after the reload', (await modules()) === 'osc,vca');
check('same session (same conversation)', (await app(() => window.patter.session)) === first);
const heard = JSON.parse((await tool('listen', { module: 'vca', seconds: 0.5 })).content);
check('and it sounds', heard.peakDb > -40, `peak ${heard.peakDb} dB`);

// ── stop / play ──────────────────────────────────────────────────────────────
await page.keyboard.press('Meta+.');
check('⌘. stops', await app(() => window.patter.stopped));
await page.waitForTimeout(900);
const quiet = await app(() => performance.now() - window.patter.engine.masterMeter.time > 400 || Math.max(...window.patter.engine.masterMeter.peak) < 0.001);
check('the master goes quiet', quiet);
const blocked = await tool('listen', { module: 'vca', seconds: 0.5 });
check('listen says the sound is stopped', blocked.isError && /stopped/.test(blocked.content));
await tool('set_params', { updates: [{ target: 'vca.cutoff', value: 900 }] });
check('edits still apply while stopped', (await app(() => window.patter.runtime.doc.modules.vca.params.cutoff)) === 900);
await page.screenshot({ path: join(shots, '2-stopped.png') });
await page.keyboard.press('Meta+.');
await page.waitForTimeout(600);
const back = await app(() => performance.now() - window.patter.engine.masterMeter.time < 300 && Math.max(...window.patter.engine.masterMeter.peak) > 0.001);
check('⌘. again plays, from where it was', !(await app(() => window.patter.stopped)) && back);

// ── save as, edit, save ──────────────────────────────────────────────────────
await page.locator('.patch-title').click();
await page.screenshot({ path: join(shots, '3-menu.png') });
await page.getByRole('button', { name: 'Save as…' }).click();
await page.locator('.dialog-input').fill(NAME);
await page.keyboard.press('Enter');
await page.waitForFunction(() => Boolean(window.patter.libraryId), null, { timeout: 5000 }).catch(() => {});
savedId = await app(() => window.patter.libraryId);
check('save as puts it in the library', Boolean(savedId) && (await app((n) => !window.patter.dirty && window.patter.runtime.doc.title === n, NAME)));
await tool('set_params', { updates: [{ target: 'osc.freq', value: 165 }] });
check('an edit makes it dirty', await app(() => window.patter.dirty));
await page.keyboard.press('Meta+s');
await page.waitForFunction(() => !window.patter.dirty, null, { timeout: 5000 }).catch(() => {});
const savedDoc = await app(async (id) => (await fetch(`/api/patches/${id}`)).json(), savedId);
check('⌘S updates the saved patch', !(await app(() => window.patter.dirty)) && savedDoc.doc?.modules?.osc?.params?.freq === 165);

// ── new patch, then come back through Recent ────────────────────────────────
await page.locator('.patch-title').click();
await page.getByRole('button', { name: 'New patch' }).click();
await page.getByRole('button', { name: 'new patch' }).click();
await page.waitForFunction((s) => window.patter.session !== s && !window.patter.dialog, first, { timeout: 8000 }).catch(() => {});
const second = await app(() => window.patter.session);
sessionsMade.add(second);
check('new patch: a fresh session, empty', second !== first && (await modules()) === '' && (await app(() => window.patter.runtime.doc.title)) === 'untitled patch');
await page.keyboard.press('Meta+o');
await page.waitForSelector('.open-list', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(300);
await page.screenshot({ path: join(shots, '4-open.png') });
const listed = await page.locator('.dialog').innerText();
check('open lists the saved patch and the earlier session', listed.includes(NAME) && /recent sessions/i.test(listed), listed.replace(/\n/g, ' | ').slice(0, 300));
await page.locator('.open-lists section').nth(1).locator('.open-main', { hasText: NAME }).first().click();
await page.waitForFunction((s) => window.patter.session === s && !window.patter.dialog && Object.keys(window.patter.runtime.doc.modules).length === 2, first, { timeout: 8000 }).catch(() => {});
check('resuming brings back that session and its patch', (await app(() => window.patter.session)) === first && (await modules()) === 'osc,vca', JSON.stringify(await app(() => ({ s: window.patter.session, d: window.patter.dialog, m: Object.keys(window.patter.runtime.doc.modules) }))) + ' first=' + first);

// ── open the saved patch: a fresh session holding it ─────────────────────────
await page.keyboard.press('Meta+o');
await page.waitForSelector('.open-list', { timeout: 5000 });
await page.locator('.open-lists section').nth(0).locator('.open-main', { hasText: NAME }).first().click();
await page.waitForFunction((s) => window.patter.session !== s && !window.patter.dialog && Object.keys(window.patter.runtime.doc.modules).length === 2, first, { timeout: 8000 }).catch(() => {});
const third = await app(() => window.patter.session);
sessionsMade.add(third);
check('open: a fresh session with the saved patch', third !== first && (await modules()) === 'osc,vca' && (await app((id) => window.patter.libraryId === id && !window.patter.dirty, savedId)));

// ── import a file ────────────────────────────────────────────────────────────
const file = join(shots, 'imported.patter.json');
writeFileSync(file, JSON.stringify({ version: 2, title: 'from a file', bpm: 96, modules: { tone: { kind: 'audio', code: 'SinOsc.ar(330) * 0.1', params: {}, play: true, level: 1, pan: 0, mute: false, fadeTime: 0.5 } }, subpatches: {}, abstractions: {}, mods: [], macros: {}, routines: {}, surface: [], master: { level: 0.8 } }));
await page.locator('.patch-menu input[type=file]').setInputFiles(file);
await page.waitForFunction(() => Boolean(window.patter.runtime.doc.modules.tone) && window.patter.seq.bpm === 96, null, { timeout: 8000 }).catch(() => {});
sessionsMade.add(await app(() => window.patter.session));
check('import: the file becomes a new session', (await modules()) === 'tone' && (await app(() => window.patter.seq.bpm)) === 96);

// ── clear, undo ──────────────────────────────────────────────────────────────
await page.locator('.patch-title').click();
await page.getByRole('button', { name: 'Clear patch' }).click();
await page.locator('.dialog').getByRole('button', { name: 'clear' }).click();
await page.waitForFunction(() => Object.keys(window.patter.runtime.doc.modules).length === 0, null, { timeout: 5000 }).catch(() => {});
check('clear empties the patch, same session', (await modules()) === '');
await page.keyboard.press('Meta+z');
await page.waitForFunction(() => Object.keys(window.patter.runtime.doc.modules).length === 1, null, { timeout: 5000 }).catch(() => {});
check('⌘Z brings it back', (await modules()) === 'tone');

// ── delete from the library ──────────────────────────────────────────────────
await page.keyboard.press('Meta+o');
await page.waitForSelector('.open-list', { timeout: 5000 });
const row = page.locator('.open-lists section').nth(0).locator('li', { hasText: NAME }).first();
await row.getByRole('button', { name: 'delete' }).click();
await row.getByRole('button', { name: 'delete for good' }).click();
await page.waitForTimeout(500);
const after = await app(async () => (await (await fetch('/api/library')).json()).patches.map((p) => p.name));
check('delete removes it from the library', !after.includes(NAME), after.join(', '));
if (!after.includes(NAME)) savedId = null;
await page.keyboard.press('Escape');

console.log('\nCONSOLE (errors/warnings):');
for (const l of logs.filter((l) => /error|warn/i.test(l) && !/favicon/.test(l)).slice(0, 30)) console.log(l);
console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
await browser.close();
await tidy();
process.exit(failures ? 1 : 0);
