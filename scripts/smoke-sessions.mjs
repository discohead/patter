// Sets, songs, sessions and branches with the real agent, in headless Chromium
// against the dev server: making a set and a song, filing a session into it
// by dragging, its AGENTS.md reaching the agent, checkpoints at every message
// and turn, branching from an answer, editing a message into a new branch and
// flipping back with ‹ ›, clearing the conversation (the patch plays on), ⌘S
// and restore, and a reload coming back to the same place.
//   node scripts/smoke-sessions.mjs [url] [screenshot-dir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:5317/';
const shots = process.argv[3] ?? 'test-results/sessions';
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
const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const state = () => page.evaluate(() => ({ session: window.patter.session, modules: Object.keys(window.patter.runtime.doc.modules), title: window.patter.runtime.doc.title }));
const start = async () => {
  await page.getByRole('button', { name: /start audio/ }).click();
  await page.waitForFunction(() => window.patter?.state === 'ready', null, { timeout: 30000 });
};
/** Send a message and wait for the turn to end (its 'after' checkpoint is kept). */
const say = async (text, timeout = 180000) => {
  await page.locator('.chat-input textarea').fill(text);
  await page.locator('.chat-input').getByRole('button', { name: 'send' }).click();
  await page.waitForFunction(() => document.querySelector('.chat-input .danger'), null, { timeout: 20000 }).catch(() => {});
  return until(() => {
    const p = window.patter;
    return !document.querySelector('.chat-input .danger') && p.checkpoints.some((k) => k.kind === 'after' && k.at === p.lastMessageId);
  }, null, timeout);
};
const sessions = new Set();
const SET = `smoke set ${Date.now() % 100000}`;
const SONG = `smoke song ${Date.now() % 100000}`;

await page.goto(url);
await start();
sessions.add((await state()).session);

// ── a set, a song in it, and this session filed there by dragging ──
await page.getByRole('button', { name: '◇＋' }).click();
await page.locator('.dialog-input').fill(SET);
await page.getByRole('button', { name: 'make the set' }).click();
await until((n) => window.patter.tree.sets.some((s) => s.name === n), SET);
await page.locator('.nav-row.folder.set', { hasText: SET }).hover();
await page.locator('.nav-row.folder.set', { hasText: SET }).locator('.nav-btn', { hasText: '＋' }).click();
await page.locator('.dialog-input').fill(SONG);
await page.getByRole('button', { name: 'make the song' }).click();
check('a set, and a song in it', await until((n) => window.patter.tree.songs.some((s) => s.name === n && s.setId), SONG));
await page.locator('.nav-row.session.current').dragTo(page.locator('.nav-row.folder.song', { hasText: SONG }));
check('dragging the session onto the song files it there', await until((n) => window.patter.song?.name === n, SONG));
check('and the title bar says where it is', (await page.locator('.session-crumbs').innerText()).replace(/\s+/g, ' ').includes(`${SET} / ${SONG} /`));
await page.locator('.nav-row.folder.song', { hasText: SONG }).locator('xpath=..').locator('.nav-row.file').click();
await page.locator('.agents-md').fill('- This song is in D minor at 92 bpm.\n- The drone is always a sine.');
await page.getByRole('button', { name: 'save' }).click();
check("the song's AGENTS.md is saved and goes to the agent", await until(() => window.patter.agentContext().song?.agents.includes('D minor')));
await page.screenshot({ path: join(shots, '1-filed.png') });

// ── a turn: checkpoints before and after ──
check('the agent builds a drone', await say("Make a quiet drone module called drone, following this song's AGENTS.md. Keep it to one module and one short sentence."));
const first = await page.evaluate(() => ({ cps: window.patter.checkpoints.map((k) => `${k.kind}:${k.modules}`), title: window.patter.runtime.doc.title, modules: Object.keys(window.patter.runtime.doc.modules) }));
check('the turn kept a checkpoint before (empty) and after (with the drone)', first.cps.includes('before:0') && first.cps.some((c) => c.startsWith('after:') && c !== 'after:0'), JSON.stringify(first));
check('the session is named (by the agent, or after the first message)', first.title !== 'untitled patch', first.title);
const reply = await page.locator('.msg-wrap.assistant').last().innerText();
check('the agent read the AGENTS.md (a sine, in D)', /sin/i.test(JSON.stringify(await page.evaluate(() => window.patter.runtime.doc.modules))) , reply.slice(0, 120));
const origin = (await state()).session;
await page.screenshot({ path: join(shots, '2-turn.png') });

// ── branch from the answer ──
await page.locator('.msg-wrap.assistant').last().hover();
await page.locator('.msg-wrap.assistant').last().getByRole('button', { name: /branch from here/ }).click();
check('⑂ branch from here makes a new session…', await until((o) => window.patter.session !== o, origin));
const branchA = await state();
sessions.add(branchA.session);
check('…with the conversation so far and the patch as the turn left it', (await until(() => document.querySelectorAll('.msg-wrap').length === 2)) && branchA.modules.includes('drone'), JSON.stringify(branchA.modules));
check('it says it is a branch, and the library nests it under the session', await until(() => Boolean(document.querySelector('.branch-start') && document.querySelector('.nav-row.session.branch.current'))));
await page.screenshot({ path: join(shots, '3-branch.png') });
await page.locator('.branch-start').getByRole('button', { name: 'back to it' }).click();
check('"back to it" goes back', await until((o) => window.patter.session === o, origin));

// ── edit the first message: a new branch from before it ──
await page.locator('.msg-wrap.user').first().hover();
await page.locator('.msg-wrap.user').first().getByRole('button', { name: /edit/ }).click();
await page.locator('.edit-composer textarea').fill('Make a quiet sine module called low at 55 Hz. Nothing else; one short sentence.');
const edited = await Promise.all([until((o) => window.patter.session !== o, origin, 20000), page.locator('.edit-composer').getByRole('button', { name: /branch & send/ }).click()]);
check('editing a message branches (the original stays)', edited[0]);
const branchB = (await state()).session;
sessions.add(branchB);
check('the edited message goes, from the patch as it was before it', await until(() => {
  const p = window.patter;
  return !document.querySelector('.chat-input .danger') && p.checkpoints.some((k) => k.kind === 'after' && k.at === p.lastMessageId);
}, null, 180000));
const b = await state();
check('…so this branch has the new module and not the old one', b.modules.includes('low') && !b.modules.includes('drone'), JSON.stringify(b.modules));
const picker = page.locator('.msg-wrap.user').first().locator('.branch-picker');
check('‹ n/m › on the edited message', (await picker.innerText()).includes('/2'), await picker.innerText().catch(() => ''));
await page.screenshot({ path: join(shots, '4-edited.png') });
await picker.getByRole('button', { name: 'previous branch' }).click();
check('‹ flips back to the original, patch and all', await until((o) => window.patter.session === o && Object.keys(window.patter.runtime.doc.modules).includes('drone'), origin));

// ── clear: a fresh conversation, the same patch playing on ──
const node = await page.evaluate(() => window.patter.runtime.module('drone')?.node);
await page.locator('.chat-bar').getByRole('button', { name: /clear/ }).click();
check('⌫ clear starts a fresh session…', await until((o) => window.patter.session !== o, origin));
sessions.add((await state()).session);
await page.waitForTimeout(600);
const cleared = { messages: await page.locator('.msg-wrap').count(), node: await page.evaluate(() => window.patter.runtime.module('drone')?.node) };
check('…with no conversation and the same patch, still playing (not rebuilt)', cleared.messages === 0 && cleared.node === node, JSON.stringify({ ...cleared, was: node }));

// ── ⌘S, change something, restore ──
await page.keyboard.press('Meta+s');
check('⌘S keeps a checkpoint', await until(() => window.patter.checkpoints.some((k) => k.kind === 'manual')));
await page.evaluate(() => window.patter.runtime.removeModule('drone', { force: true }));
await page.locator('.checkpoint-mark').getByRole('button', { name: /restore/ }).click();
check('⟲ restore brings the patch back', await until(() => Boolean(window.patter.runtime.doc.modules.drone)));
await page.keyboard.press('Meta+z');
check('and ⌘Z takes the restore away again', await until(() => !window.patter.runtime.doc.modules.drone));
await page.keyboard.press('Meta+Shift+z');

// ── a reload comes back to the same place ──
const before = await state();
await page.waitForTimeout(1500);
await page.reload();
await start();
await page.waitForTimeout(800);
const after = await state();
check('a reload comes back to this session, in its song', after.session === before.session && (await page.evaluate(() => window.patter.song?.name)) === SONG, `${after.session === before.session} ${await page.evaluate(() => window.patter.song?.name)}`);
await page.screenshot({ path: join(shots, '5-reloaded.png') });

console.log('\npage errors:', logs.slice(0, 5));
console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
// Tidy up: the set (and the song, and its sessions), and the rest.
const setId = await page.evaluate((n) => window.patter.tree.sets.find((s) => s.name === n)?.id, SET);
await browser.close();
const del = (path) => fetch(new URL(`/api/${path}`, url), { method: 'DELETE', headers: { 'x-patter': '1' } }).catch(() => {});
if (setId) await del(`sets/${setId}?cascade=1`);
for (const s of sessions) await del(`sessions/${s}`);
process.exit(failures ? 1 : 0);
