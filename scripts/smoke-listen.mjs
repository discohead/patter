// Listener mode in headless Chromium against the dev server: the host builds
// a patch and goes on air; a listener (?listen, since local development has
// no Access and everyone is the host) hears the same patch, can't prompt or
// write, turns knobs of its own, follows the host's changes, detaches and
// rejoins, reads the conversation, and sees the host go off air. The
// listener's page must never ask for /api or /agents.
//   node scripts/smoke-listen.mjs [url] [screenshot-dir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:5317/';
const shots = process.argv[3] ?? 'test-results/listen';
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
// Two contexts: two browsers, as far as storage goes (the host's session, the listener's nothing).
const hostCtx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const listenCtx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const host = await hostCtx.newPage();
const listener = await listenCtx.newPage();
const errors = [];
for (const [who, page] of [['host', host], ['listener', listener]]) page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
const asked = [];
listener.on('request', (r) => asked.push(new URL(r.url()).pathname));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const until = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const start = async (page) => {
  await page.getByRole('button', { name: /start audio/ }).click();
  await page.waitForFunction(() => window.patter?.state === 'ready', null, { timeout: 30000 });
};
const tool = (name, input) =>
  host.evaluate(async ([n, i]) => {
    const { runTool } = await import('/src/agent/tools.ts');
    const p = window.patter;
    return runTool(n, i, { runtime: p.runtime, seq: p.seq, engine: p.engine });
  }, [name, input]);
const value = (page, module, param) => page.evaluate(([m, p]) => window.patter.runtime.paramValue(m, p), [module, param]);

// ── the host builds a patch and goes on air ──
await host.goto(url);
await start(host);
check('the host is the host', await host.evaluate(() => window.patter.role === 'host'));
await tool('define_module', { name: 'lfo', kind: 'control', code: "SinOsc.kr(param('rate', 0.3, 'lofreq'))" });
await tool('define_module', { name: 'osc', kind: 'audio', play: false, code: "Mix(Saw.ar(param('freq', 110, 'freq') * [1, 1.006])) * 0.15" });
await tool('define_module', { name: 'filter', kind: 'audio', code: "Pan2.ar(MoogFF.ar(input('osc'), param('cutoff', 800, 'freq'), param('res', 2, [0, 3.9])), 0)" });
await tool('modulate', { routes: [{ source: 'lfo', target: 'filter.cutoff', amount: 0.3 }] });
await tool('define_macro', { name: 'dark', label: 'Darkness', value: 0.2, targets: [{ target: 'filter.res', amount: 0.2 }] });
await host.evaluate(() => window.patter.runtime.setTitle('smoke on air'));
// (Going on air takes it over from any other tab, a previous run's included.)
await host.waitForFunction(() => !window.patter.broadcast.busy);
await host.locator('button.on-air').click();
check('the host goes on air', await until(host, () => window.patter.broadcast.state === 'on'));

// ── a listener tunes in ──
await listener.goto(`${url}?listen`);
check('?listen makes a listener', await listener.evaluate(() => window.patter.role === 'listener'));
check('the network strip links back to datspace', (await listener.locator('.network a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))).join(' ') === 'https://datspace.io/ https://datspace.io/ https://datspace.ai/ https://datspace.dev/ https://datspace.fm/ https://datspace.music/ https://datspace.studio/ https://github.com/discohead/patter https://github.com/samaaron/supersonic');
check('the start screen says what is on air', (await listener.locator('.boot').innerText()).includes('On air: “smoke on air” (3 modules)'));
await start(listener);
const modules = () => listener.evaluate(() => Object.keys(window.patter.runtime.doc.modules).sort().join(','));
check("the listener plays the host's patch", await until(listener, () => Object.keys(window.patter.runtime.doc.modules).length === 3), await modules());
check('with its routes and macros', await listener.evaluate(() => window.patter.runtime.doc.mods.length === 2 && Boolean(window.patter.runtime.doc.macros.dark)));
check('there is no composer, only the line about who prompts', (await listener.locator('.chat-input, .composer-input').count()) === 0 && (await listener.locator('.listen-note').innerText()) === "Only Jared can prompt. You're listening.");
check('there is no library, session menu, upload or undo', (await listener.locator('.navigator, .nav-toggle, .patch-title, .add-sample, .record-row').count()) === 0 && (await listener.locator('button[title="undo (⌘Z)"]').count()) === 0);
check('the title bar says what is on air', (await listener.locator('.top').innerText()).includes('smoke on air') && (await listener.locator('.on-air-status').innerText()).startsWith('on air'));
await listener.evaluate(() => window.patter.select('osc'));
check('module code is shown read-only', (await listener.locator('.code-panel textarea').getAttribute('readonly')) !== null && (await listener.getByRole('button', { name: 'apply' }).count()) === 0 && (await listener.locator('.code-panel').getByRole('button', { name: 'remove' }).count()) === 0);
check('knobs carry no ☆ (the panel is the host’s)', (await listener.locator('.knob .pin').count()) === 0 && (await listener.locator('.knob').count()) > 0);
await listener.screenshot({ path: join(shots, '1-listening.png') });

// ── knobs: the listener's own, until the host's next change ──
await listener.evaluate(() => window.patter.runtime.setParam('osc', 'freq', 220));
check("a listener's knob changes the sound there", (await value(listener, 'osc', 'freq')) === 220);
check("and not the host's", (await value(host, 'osc', 'freq')) === 110);
await host.evaluate(() => window.patter.runtime.setParam('filter', 'cutoff', 1500));
check("the host's next change comes in, in place", await until(listener, () => window.patter.runtime.paramValue('filter', 'cutoff') === 1500));
check('and, following, puts back the knob the listener turned', (await value(listener, 'osc', 'freq')) === 110);
const node = await listener.evaluate(() => window.patter.runtime.module('osc').node);
await tool('define_module', { name: 'osc', kind: 'audio', play: false, code: "Mix(Pulse.ar(param('freq', 110, 'freq') * [1, 1.004], 0.3)) * 0.15" });
check('new code crossfades in on the listener', await until(listener, (n) => window.patter.runtime.module('osc').node !== n && window.patter.runtime.doc.modules.osc.code.includes('Pulse'), node));

// ── detached, the host's changes wait; rejoining brings them ──
await listener.locator('.follow input[type=checkbox]').uncheck();
await host.evaluate(() => window.patter.runtime.setParam('filter', 'cutoff', 3000));
check('detached, a change waits to be rejoined', await until(listener, () => document.querySelector('.rejoin')?.textContent?.includes('1 change waiting')));
check('and the patch here stays as it was', (await value(listener, 'filter', 'cutoff')) === 1500);
await listener.locator('.rejoin').click();
check('rejoining brings the newest', await until(listener, () => window.patter.runtime.paramValue('filter', 'cutoff') === 3000));
check('and follows again', await listener.evaluate(() => window.patter.radio.following));

// ── the transport, and the conversation ──
await host.evaluate(() => window.patter.stop());
check("the host's ⌘. stops the listener's sound", await until(listener, () => window.patter.stopped));
await host.evaluate(() => window.patter.play());
check('and play starts it again', await until(listener, () => !window.patter.stopped));
await host.evaluate(() =>
  window.patter.broadcast.sendTranscript(window.patter.session, [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'make it darker' }] },
    { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Turned the **darkness** up.' }, { type: 'tool', name: 'define_macro', subject: 'dark', state: 'ok', result: 'macro dark: 2 targets' }] },
  ]),
);
check('the conversation shows up to read', await until(listener, () => document.querySelector('.transcript .msg.user')?.textContent === 'make it darker'));
check('tool calls collapsed', (await listener.locator('.transcript .tool .tool-body').count()) === 0 && (await listener.locator('.transcript .tool-head').innerText()).includes('macro · dark'));
await listener.locator('.transcript .tool-head').click();
check('and open on a click', (await listener.locator('.transcript .tool-body').innerText()).includes('macro dark: 2 targets'));
await listener.screenshot({ path: join(shots, '2-conversation.png') });

// ── samples: only what's on air ──
const sample = await listener.evaluate(async () => (await fetch(`/listen/samples/${'0'.repeat(64)}`)).status);
check("a library sample that isn't on air can't be had", sample === 404, String(sample));

// ── off air ──
await host.locator('button.on-air').click();
check('the host goes off air', await until(host, () => window.patter.broadcast.state === 'off'));
check('the listener sees since when, and keeps playing', await until(listener, () => document.querySelector('.on-air-status')?.textContent?.startsWith('off air since')) && (await modules()) === 'filter,lfo,osc');
await listener.screenshot({ path: join(shots, '3-off-air.png') });

const reached = [...new Set(asked.filter((p) => p.startsWith('/api/') || p.startsWith('/agents/')))];
check("the listener's page never asked for /api or /agents", reached.length === 0, reached.join(', '));
check('no page errors', errors.length === 0, errors.join(' | '));

const made = await host.evaluate(() => window.patter.session).catch(() => null);
await browser.close();
if (made) await fetch(new URL(`/api/sessions/${made}`, url), { method: 'DELETE', headers: { 'x-patter': '1' } }).catch(() => {});
console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
