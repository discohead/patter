// Subpatches end to end in headless Chromium: build a patch through the
// agent's tools, group it, make an abstraction and a second instance, edit
// one instance, then drive the graph UI (select, open, group, undo) and
// screenshot each step.
//   node scripts/smoke-hierarchy.mjs [url] [screenshot-dir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5317/';
const shots = process.argv[3] ?? 'test-results/hierarchy';
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.getByRole('button', { name: /start audio/ }).click();
await page.waitForFunction(() => window.patter?.state === 'ready' || window.patter?.state === 'error', null, { timeout: 30000 });
console.log('BOOT', await page.evaluate(() => window.patter.state));

const tool = (name, input) =>
  page.evaluate(
    async ([n, i]) => {
      const { runTool } = await import('/src/agent/tools.ts');
      const p = window.patter;
      return runTool(n, i, { runtime: p.runtime, seq: p.seq, engine: p.engine });
    },
    [name, input],
  );
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const run = async (name, input, quiet = true) => {
  const out = await tool(name, input);
  if (out.isError || !quiet) console.log(`=== ${name} ${JSON.stringify(input).slice(0, 90)}\n${out.isError ? 'ERROR ' : ''}${out.content.slice(0, 1600)}`);
  return out;
};
const json = (out) => JSON.parse(out.content);

// ── build flat, then structure it ────────────────────────────────────────────
await run('define_module', { name: 'lfo', kind: 'control', code: "SinOsc.kr(param('rate', 0.3, 'lofreq'))" });
await run('define_module', { name: 'osc', kind: 'audio', play: false, code: "Mix(Saw.ar(param('freq', 110, 'freq') * [1, 1.006, 0.994])) * 0.15" });
await run('define_module', { name: 'filter', kind: 'audio', play: false, code: "MoogFF.ar(input('osc'), param('cutoff', 900, { min: 40, max: 12000, warp: 'exp', lag: 0.05 }) * (1 + input('lfo') * 0.3), param('res', 2, [0, 3.9]))" });
await run('define_module', { name: 'vca', kind: 'audio', code: "Pan2.ar(input('filter') * param('level', 0.8, 'amp'), 0)" });
const nodesBefore = await page.evaluate(() => ({ osc: window.patter.runtime.module('osc').node, filter: window.patter.runtime.module('filter').node }));

const g = json(await run('subpatch', { action: 'group', path: 'voice', members: ['osc', 'filter'], description: 'saw through a ladder filter' }, false));
check('group made an inlet for the lfo', g.inlets?.lfo === 'lfo');
check('group made the main outlet', g.outlets?.out === 'filter');
const nodesAfter = await page.evaluate(() => ({ osc: window.patter.runtime.module('voice/osc').node, filter: window.patter.runtime.module('voice/filter').node }));
check('grouped modules kept running (same nodes)', nodesAfter.osc === nodesBefore.osc && nodesAfter.filter === nodesBefore.filter);
const heard = json(await run('listen', { module: 'vca', seconds: 1 }));
check('vca still sounds after grouping', heard.peakDb > -40, `peak ${heard.peakDb} dB`);

await run('subpatch', { action: 'configure', path: 'voice', controls: { cutoff: 'filter.cutoff', pitch: 'osc.freq' } }, false);
await run('set_params', { updates: [{ target: 'voice.cutoff', value: 1400 }] });
check('a control sets the inner param', (await page.evaluate(() => window.patter.runtime.doc.modules['voice/filter'].params.cutoff)) === 1400);

await run('abstraction', { action: 'save', path: 'voice', name: 'synth', description: 'saw → ladder' }, false);
const inst = json(await run('abstraction', { action: 'instantiate', name: 'synth', path: 'voice2', inlets: { lfo: 'lfo' }, params: { pitch: 165 } }, false));
check('instance built without warnings', inst.warnings.length === 0, inst.warnings.join('; '));
const shared = await page.evaluate(() => window.patter.runtime.module('voice2/osc').defName === window.patter.runtime.module('voice/osc').defName);
check('instances share a SynthDef', shared);
await run('define_module', { name: 'mix', kind: 'audio', code: "Pan2.ar(input('voice2') * 0.8, 0.3)" });
const v2 = json(await run('listen', { module: 'voice2', seconds: 1 }));
check('voice2 sounds at its own pitch', v2.peakDb > -40 && Math.abs((v2.pitchHz ?? v2.pitch?.hz ?? 165) - 165) < 20, `peak ${v2.peakDb} dB, pitch ${JSON.stringify(v2.pitchHz ?? v2.pitch)}`);

const edit = json(await run('define_module', { name: 'voice2/filter', kind: 'audio', code: "RLPF.ar(input('osc'), param('cutoff', 900, { min: 40, max: 12000, warp: 'exp', lag: 0.05 }) * (1 + input('lfo') * 0.3), param('res', 0.3, [0.05, 1]))" }));
check('editing one instance reaches the other', edit.abstraction?.instancesUpdated?.includes('voice'), JSON.stringify(edit.abstraction));
check('the other instance kept its knob', (await page.evaluate(() => window.patter.runtime.doc.modules['voice/filter'].params.cutoff)) === 1400);

const mermaid = (await run('graph', {})).content;
check('mermaid nests subpatches', /subgraph voice/.test(mermaid) && /subgraph voice2/.test(mermaid));
const sub = json(await run('inspect', { what: 'subpatch', name: 'voice2' }, false));
check('inspect subpatch resolves the inlet', sub.inlets?.lfo?.resolves === 'lfo');

// ── the UI ───────────────────────────────────────────────────────────────────
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/1-root.png` });
const node = (id) => page.locator(`g.node`).filter({ has: page.locator('title', { hasText: new RegExp(`^${id}( —|$)`) }) }).first();
await node('voice').click();
check('click selects the subpatch', (await page.evaluate(() => window.patter.selection.join())) === 'voice');
check('the knob area switches to Selected', (await page.evaluate(() => window.patter.panel)) === 'selected');
await page.screenshot({ path: `${shots}/2-selected-voice.png` });
await node('voice').dblclick();
check('double-click opens it', (await page.evaluate(() => window.patter.scope)) === 'voice');
await page.waitForTimeout(200);
await page.screenshot({ path: `${shots}/3-inside-voice.png` });
await node('voice/filter').click();
await page.screenshot({ path: `${shots}/4-filter-selected.png` });
const knobs = await page.locator('.surface .knob .knob-label').allTextContents();
check('Selected shows only the filter knobs', knobs.join(',') === 'cutoff,res', knobs.join(','));
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
check('esc twice: deselect, then up', (await page.evaluate(() => [window.patter.scope, window.patter.selection.join()])).join('|') === '|voice');

// group two top-level things from the UI: shift-click, ⌘G, name, enter
await page.keyboard.press('Escape');
await node('vca').click();
await node('mix').click({ modifiers: ['Shift'] });
await page.keyboard.press('Meta+g');
await page.locator('.name-input').fill('out');
await page.keyboard.press('Enter');
await page.waitForFunction(() => Boolean(window.patter.runtime.doc.subpatches.out), null, { timeout: 5000 }).catch(() => {});
const grouped = await page.evaluate(() => Object.keys(window.patter.runtime.doc.modules).sort().join(','));
check('⌘G grouped vca and mix', grouped.includes('out/vca') && grouped.includes('out/mix'), grouped);
await page.waitForTimeout(200);
await page.screenshot({ path: `${shots}/5-grouped-out.png` });
await page.keyboard.press('Meta+z');
await page.waitForFunction(() => !window.patter.runtime.doc.subpatches.out, null, { timeout: 8000 }).catch(() => {});
check('⌘Z undoes the grouping', await page.evaluate(() => !window.patter.runtime.doc.subpatches.out && Boolean(window.patter.runtime.doc.modules.vca)));

// pin a knob onto the top level's Performance Panel
await page.evaluate(() => window.patter.select(null));
await node('voice').click();
await page.locator('.surface .knob').filter({ hasText: 'cutoff' }).first().hover();
await page.locator('.surface .knob').filter({ hasText: 'cutoff' }).first().locator('.pin').click();
const surface = await page.evaluate(() => window.patter.runtime.doc.surface.map((s) => s.ref));
check('☆ pins to the Performance Panel', surface.includes('voice/filter.cutoff'), surface.join(','));
await page.evaluate(() => window.patter.select(null));
await page.waitForTimeout(150);
await page.screenshot({ path: `${shots}/6-performance.png` });

console.log('\nCONSOLE (errors/warnings):');
for (const l of logs.filter((l) => /error|warn/i.test(l)).slice(0, 30)) console.log(l);
console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
const made = await page.evaluate(() => window.patter.session).catch(() => null);
await browser.close();
if (made) await fetch(new URL(`/api/sessions/${made}`, url), { method: 'DELETE', headers: { 'x-patter': '1' } }).catch(() => {});
process.exit(failures ? 1 : 0);
