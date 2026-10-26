// End-to-end smoke test in headless Chromium: boot SuperSonic, build a patch
// through the agent's own tools, and listen to it.
//   node scripts/smoke.mjs [url]
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:5317/';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url);
await page.getByRole('button', { name: /start audio/ }).click();
await page.waitForFunction(() => window.patter?.state === 'ready' || window.patter?.state === 'error', null, { timeout: 30000 });
const state = await page.evaluate(() => ({ state: window.patter.state, error: window.patter.bootError, mode: window.patter.engine.sonic.mode, isolated: crossOriginIsolated }));
console.log('BOOT', JSON.stringify(state));

const tool = (name, input) => page.evaluate(async ([n, i]) => {
  const { runTool } = await import('/src/agent/tools.ts');
  const p = window.patter;
  return runTool(n, i, { runtime: p.runtime, seq: p.seq, engine: p.engine });
}, [name, input]);

const steps = [
  ['define_module', { name: 'lfo', kind: 'control', code: "SinOsc.kr(param('rate', 0.3, 'lofreq'))" }],
  ['define_module', { name: 'osc', kind: 'audio', play: false, code: "const f = param('freq', 110, 'freq');\nMix(Saw.ar(f * [1, 1.006, 0.994])) * 0.15" }],
  ['define_module', { name: 'filter', kind: 'audio', code: "const cutoff = param('cutoff', 800, { min: 40, max: 12000, warp: 'exp', unit: 'Hz', lag: 0.05 });\nPan2.ar(MoogFF.ar(input('osc'), cutoff, param('res', 2, [0, 3.9])), 0)" }],
  ['modulate', { routes: [{ source: 'lfo', target: 'filter.cutoff', amount: 0.3 }] }],
  ['define_macro', { name: 'dark', label: 'Darkness', value: 0.2, targets: [{ target: 'filter.cutoff', amount: -0.5 }, { target: 'filter.res', amount: 0.2 }] }],
  ['listen', { module: 'filter', seconds: 1 }],
  ['listen', { module: 'lfo', seconds: 1 }],
  ['graph', {}],
  ['graph', { module: 'filter' }],
  ['define_module', { name: 'pluck', kind: 'voice', code: "const freq = param('freq', 220, 'freq');\nconst gate = param('gate', 1);\nconst env = EnvGen.kr(Env.adsr(0.002, 0.2, 0.3, 0.3), gate, { doneAction: 2 });\nPan2.ar(RLPF.ar(Pulse.ar(freq, 0.3), freq * 6, 0.3) * env * 0.2, 0)" }],
  ['define_routine', { name: 'melody', code: "const r = turing(8, 0.2);\nwhile (true) { play('pluck', { note: degree(Math.floor(r.next() * 8), 'minorPentatonic', 60), dur: 0.25 }); yield 0.25; }", quant: 0 }],
  ['listen', { module: 'pluck', seconds: 1.5 }],
  ['trace', { module: 'filter' }],
  ['define_module', { name: 'broken', kind: 'audio', code: 'SinOsc.ar(440, { mull: 2 })' }],
  ['inspect', { what: 'log' }],
];
for (const [name, input] of steps) {
  const out = await tool(name, input);
  const text = out.content.length > 1400 ? `${out.content.slice(0, 1400)}…` : out.content;
  console.log(`\n=== ${name} ${JSON.stringify(input).slice(0, 80)}\n${out.isError ? 'ERROR ' : ''}${text}`);
}
const master = await page.evaluate(() => window.patter.engine.masterMeter);
console.log('\nMASTER METER', JSON.stringify(master));
console.log('\nCONSOLE (errors/warnings):');
for (const l of logs.filter((l) => /error|warn/i.test(l)).slice(0, 30)) console.log(l);
const made = await page.evaluate(() => window.patter.session).catch(() => null);
await browser.close();
if (made) await fetch(new URL(`/api/sessions/${made}`, url), { method: 'DELETE', headers: { 'x-patter': '1' } }).catch(() => {});
