// Sessions, the library and the transport, end to end in headless Chromium
// against the dev server: autosave and restore across a reload, ⌘. stop and
// play, ⌘S checkpoints, a new session and back through the library (⌘O),
// rename, filing in a song, import, clear and undo, delete. Screenshots go to
// the given directory.
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
// After the browser closes (closing re-saves the open session): from here, not the page.
const tidy = async () => {
  const del = (path) => fetch(new URL(`/api/${path}`, url), { method: 'DELETE', headers: { 'x-patter': '1' } }).catch(() => {});
  for (const s of sessionsMade) await del(`sessions/${s}`);
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
let remote = {};
for (let i = 0; i < 20; i++) {
  remote = await app(async (s) => (await fetch(`/api/sessions/${s}`)).json(), first);
  if (Object.keys(remote.doc?.modules ?? {}).length === 2) break;
  await page.waitForTimeout(300);
}
check('the session autosaves to the server', Object.keys(remote.doc?.modules ?? {}).length === 2 && remote.doc.title === 'library smoke', JSON.stringify({ title: remote.doc?.title, modules: Object.keys(remote.doc?.modules ?? {}) }));

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

// ── ⌘S: a checkpoint ─────────────────────────────────────────────────────────
await page.keyboard.press('Meta+s');
check('⌘S keeps a checkpoint of the patch', await page.waitForFunction(() => window.patter.checkpoints.some((k) => k.kind === 'manual'), null, { timeout: 5000 }).then(() => true, () => false));

// ── a new session, then back through the library ─────────────────────────────
await page.getByRole('button', { name: '＋ New session' }).click();
await page.waitForFunction((s) => window.patter.session !== s, first, { timeout: 8000 }).catch(() => {});
const second = await app(() => window.patter.session);
sessionsMade.add(second);
check('＋ New session: a fresh session, empty, on its own', second !== first && (await modules()) === '' && (await app(() => window.patter.entry?.songId ?? null)) === null);
await page.screenshot({ path: join(shots, '3-library.png') });
await page.keyboard.press('Meta+o');
await page.waitForFunction(() => document.activeElement?.classList.contains('nav-search'), null, { timeout: 2000 }).catch(() => {});
await page.keyboard.type('library smoke');
await page.waitForTimeout(300);
await page.screenshot({ path: join(shots, '3b-find.png') });
const found = await page.locator('.nav-tree .nav-row.session').allInnerTexts();
console.log('  search box:', await page.locator('.nav-search').inputValue(), '| focused:', await app(() => document.activeElement?.className));
check('⌘O finds a session by name', found.length === 1 && found[0].includes('library smoke'), found.join(' | '));
await page.locator('.nav-tree .nav-row.session', { hasText: 'library smoke' }).click();
await page.waitForFunction((s) => window.patter.session === s && Object.keys(window.patter.runtime.doc.modules).length === 2, first, { timeout: 8000 }).catch(() => {});
check('clicking it brings back that session and its patch', (await app(() => window.patter.session)) === first && (await modules()) === 'osc,vca');
await page.locator('.nav-search').fill('');

// ── rename and file it, from the library ─────────────────────────────────────
await page.locator('.nav-row.session.current').dblclick();
await page.locator('.dialog-input').fill(NAME);
await page.getByRole('button', { name: 'rename' }).click();
check('double-click renames (the patch takes the title)', await page.waitForFunction((n) => window.patter.runtime.doc.title === n && window.patter.entry?.title === n, NAME, { timeout: 5000 }).then(() => true, () => false));
const songId = await app(() => window.patter.createSong('library smoke song'));
await page.locator('.nav-row.session.current').hover();
await page.locator('.nav-row.session.current .nav-btn').click();
await page.getByRole('button', { name: /Move to/ }).click();
await page.getByRole('button', { name: '♫ library smoke song' }).click();
check('the ⋯ menu files it in a song', await page.waitForFunction(() => window.patter.song?.name === 'library smoke song', null, { timeout: 5000 }).then(() => true, () => false));

// ── import a file: a new session beside this one ─────────────────────────────
const file = join(shots, 'imported.patter.json');
writeFileSync(file, JSON.stringify({ version: 2, title: 'from a file', bpm: 96, modules: { tone: { kind: 'audio', code: 'SinOsc.ar(330) * 0.1', params: {}, play: true, level: 1, pan: 0, mute: false, fadeTime: 0.5 } }, subpatches: {}, abstractions: {}, mods: [], macros: {}, routines: {}, surface: [], master: { level: 0.8 } }));
await page.locator('.patch-menu input[type=file]').setInputFiles(file);
await page.waitForFunction(() => Boolean(window.patter.runtime.doc.modules.tone) && window.patter.seq.bpm === 96, null, { timeout: 8000 }).catch(() => {});
sessionsMade.add(await app(() => window.patter.session));
const imported = await app(() => ({ m: Object.keys(window.patter.runtime.doc.modules).join(','), bpm: window.patter.seq.bpm, song: window.patter.song?.name, listed: Boolean(window.patter.entry) }));
check('import: the file becomes a new session, in the same song', imported.m === 'tone' && imported.bpm === 96 && imported.song === 'library smoke song', JSON.stringify(imported));

// ── clear, undo ──────────────────────────────────────────────────────────────
await page.locator('.patch-title').click();
await page.getByRole('button', { name: 'Clear the patch…' }).click();
await page.locator('.dialog').getByRole('button', { name: 'clear' }).click();
await page.waitForFunction(() => Object.keys(window.patter.runtime.doc.modules).length === 0, null, { timeout: 5000 }).catch(() => {});
check('clear empties the patch, same session', (await modules()) === '');
await page.keyboard.press('Meta+z');
await page.waitForFunction(() => Object.keys(window.patter.runtime.doc.modules).length === 1, null, { timeout: 5000 }).catch(() => {});
check('⌘Z brings it back', (await modules()) === 'tone');

// ── delete it: the library moves on, and a late autosave can't bring it back ──
const doomed = await app(() => window.patter.session);
await page.locator('.patch-title').click();
await page.getByRole('button', { name: 'Delete session…' }).click();
await page.locator('.dialog').getByRole('button', { name: 'delete' }).click();
await page.waitForFunction((s) => window.patter.session !== s, doomed, { timeout: 8000 }).catch(() => {});
await app((s) => fetch(`/api/sessions/${s}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: { title: 'ghost', modules: {} }, updated: Date.now() }) }), doomed);
const listed = await app(async () => (await (await fetch('/api/library')).json()).sessions.map((s) => s.name));
check('delete removes the session (and it stays gone)', !listed.includes(doomed) && (await app(() => window.patter.session)) !== doomed);
await app((id) => fetch(`/api/songs/${id}`, { method: 'DELETE', headers: { 'x-patter': '1' } }), songId);

console.log('\nCONSOLE (errors/warnings):');
for (const l of logs.filter((l) => /error|warn/i.test(l) && !/favicon/.test(l)).slice(0, 30)) console.log(l);
console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
await browser.close();
await tidy();
process.exit(failures ? 1 : 0);
