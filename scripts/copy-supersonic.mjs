// Copies SuperSonic's run-time files (workers, AudioWorklet, wasm, synthdefs)
// and Sonic Pi's sample pack into public/, where the browser fetches them by
// URL, and writes an index of the samples.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const pub = join(root, 'public');

const copies = [
  ['supersonic-scsynth/dist/workers', 'supersonic/workers'],
  ['supersonic-scsynth/dist/chunks', 'supersonic/chunks'],
  ['supersonic-scsynth-core/wasm', 'supersonic-core/wasm'],
  ['supersonic-scsynth-core/workers', 'supersonic-core/workers'],
  ['supersonic-scsynth-synthdefs/synthdefs', 'synthdefs'],
  ['supersonic-scsynth-samples/samples', 'samples'],
];

for (const [from, to] of copies) {
  const src = join(nm, from);
  const dst = join(pub, to);
  if (!existsSync(src)) {
    console.warn(`[copy-supersonic] missing ${src}`);
    continue;
  }
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`[copy-supersonic] ${from} -> public/${to}`);
}

// The stock pack's index: name (the file without .flac), category (the
// prefix before the first underscore) and size.
const samples = join(pub, 'samples');
if (existsSync(samples)) {
  const index = readdirSync(samples)
    .filter((f) => f.endsWith('.flac'))
    .sort()
    .map((f) => ({ name: f.replace(/\.flac$/, ''), category: f.split('_')[0], bytes: statSync(join(samples, f)).size }));
  writeFileSync(join(samples, 'index.json'), JSON.stringify(index));
  console.log(`[copy-supersonic] public/samples/index.json (${index.length} samples)`);
}
