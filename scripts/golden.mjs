// Compiles the reference SynthDefs in test/golden/cases.json with sclang and
// writes their bytes to test/golden/<name>.scsyndef, so the TypeScript
// compiler can be checked against sclang's own output.
//
// sclang runs with HOME pointed at an empty directory so the user's
// startup.scd (which may boot a server) is never loaded.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'test', 'golden');
const cases = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));
const sclang = process.env.SCLANG ?? '/Applications/SuperCollider.app/Contents/MacOS/sclang';
const home = mkdtempSync(join(tmpdir(), 'patter-sclang-'));
mkdirSync(dir, { recursive: true });

const lines = ['('];
for (const c of cases) {
  const out = join(dir, `${c.name}.scsyndef`);
  lines.push(`try {
  var d = SynthDef(\\${c.name}, ${c.sclang});
  var f = File(${JSON.stringify(out)}, "wb");
  f.write(d.asBytes); f.close;
  "OK ${c.name}".postln;
} { |e| ("FAIL ${c.name} " ++ e.errorString).postln };`);
}
lines.push('0.exit;', ')');
const script = join(home, 'golden.scd');
writeFileSync(script, lines.join('\n'));
const log = execFileSync(sclang, [script], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 120000 });
const results = log.split('\n').filter((l) => /^(OK|FAIL) /.test(l));
console.log(results.join('\n'));
if (results.some((l) => l.startsWith('FAIL'))) process.exitCode = 1;
