// Copies SuperSonic's run-time files (workers, AudioWorklet, wasm, synthdefs)
// into public/, where the browser fetches them by URL during init().
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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
