// Agent end-to-end: describe a patch in the chat and let DeepSeek (Workers AI
// via AI Gateway, in the local PatterAgent Durable Object) build it.
//   node scripts/smoke-agent.mjs [prompt ...]   (several prompts: sent one after another)
import { chromium } from '@playwright/test';

const prompts = process.argv.length > 2 ? process.argv.slice(2) : [
  'Two slightly detuned saw oscillators at 110 Hz into a resonant Moog-style low-pass filter. A slow sine LFO sweeps the cutoff. Give me a cutoff knob and a resonance knob, then listen to make sure it sounds right.',
];
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto('http://localhost:5317/');
await page.getByRole('button', { name: /start audio/ }).click();
await page.waitForFunction(() => window.patter?.state === 'ready', null, { timeout: 30000 });

const input = page.locator('textarea.composer-input');
// Each prompt is sent once the previous turn has gone quiet.
for (const p of prompts) {
  const before = await page.locator('.tool').count();
  await input.fill(p);
  await input.press('Enter');
  console.log('\nSENT:', p);
  const t0 = Date.now();
  let lastSummary = '';
  let idle = 0;
  while (Date.now() - t0 < 240_000) {
    await page.waitForTimeout(3000);
    const s = await page.evaluate(() => ({
      modules: Object.keys(window.patter.runtime.doc.modules),
      subpatches: Object.keys(window.patter.runtime.doc.subpatches),
      mods: window.patter.runtime.doc.mods.length,
      surface: window.patter.runtime.doc.surface.length,
      tools: [...document.querySelectorAll('.tool')].map((t) => `${t.className.replace('tool ', '')}:${t.querySelector('.tool-head span:nth-child(2)')?.textContent}`),
      running: !!document.querySelector('.chat .danger'),
    }));
    const summary = JSON.stringify({ ...s, tools: s.tools.slice(before) });
    if (summary !== lastSummary) {
      console.log(`${Math.round((Date.now() - t0) / 1000)}s`, summary.slice(0, 600));
      lastSummary = summary;
    }
    const busy = s.running || s.tools.some((t) => t.startsWith('tool-running'));
    idle = busy ? 0 : idle + 1;
    if (idle >= 3 && s.tools.length > before) break;
  }
}
const transcript = await page.locator('.chat-list').innerText();
console.log('\n--- TRANSCRIPT ---\n' + transcript.slice(-2500));
const doc = await page.evaluate(() => {
  const d = window.patter.runtime.doc;
  return {
    modules: Object.fromEntries(Object.entries(d.modules).map(([k, v]) => [k, { kind: v.kind, params: v.params, play: v.play }])),
    subpatches: d.subpatches,
    abstractions: Object.fromEntries(Object.entries(d.abstractions).map(([k, a]) => [k, { modules: Object.keys(a.modules), interface: a.subpatches[''], instances: window.patter.runtime.instancesOf(k) }])),
    macros: d.macros,
    mods: d.mods.map((m) => `${m.source} → ${m.target} × ${m.amount}`),
    surface: d.surface.map((s) => s.ref),
  };
});
const tools = await page.evaluate(() => [...document.querySelectorAll('.tool')].map((t) => `${t.className.includes('tool-error') ? '✗' : '✓'} ${t.querySelector('.tool-head')?.textContent?.trim().slice(0, 110)}`));
console.log('\n--- TOOLS ---\n' + tools.join('\n'));
console.log('\n--- DOC ---\n' + JSON.stringify(doc, null, 1).slice(0, 6000));
const listen = await page.evaluate(async () => {
  const names = Object.keys(window.patter.runtime.doc.modules);
  const out = names.find((n) => window.patter.runtime.doc.modules[n].play) ?? names[0];
  return out ? window.patter.runtime.listen(out, 1) : null;
});
console.log('\n--- LISTEN ---\n', JSON.stringify(listen)?.slice(0, 600));
console.log('\n--- PAGE ERRORS ---\n' + errors.slice(0, 20).join('\n'));
await browser.close();
