// Patch-language SynthDefs vs sclang 3.14.1's, compared semantically.
// Regenerate the references with `npm run golden`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSynthDef } from '../src/sc/build';
import { decodeSynthDefs, encodeSynthDefs } from '../src/sc/synthdef';
import { canonicalize } from './canon';

const dir = join(__dirname, 'golden');
const cases: { name: string; args: Record<string, number>; js: string }[] = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));

describe('SCgf codec', () => {
  it('round-trips every reference SynthDef byte for byte', () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.scsyndef'))) {
      const bytes = new Uint8Array(readFileSync(join(dir, f)));
      const defs = decodeSynthDefs(bytes);
      expect(encodeSynthDefs(defs), f).toEqual(bytes);
    }
  });
});

describe('patch language ≡ sclang', () => {
  for (const c of cases) {
    it(c.name, () => {
      const ref = decodeSynthDefs(new Uint8Array(readFileSync(join(dir, `${c.name}.scsyndef`))))[0];
      const ours = buildSynthDef(c.name, c.args, c.js);
      const a = canonicalize(ours.data);
      const b = canonicalize(ref);
      expect(a.params).toEqual(b.params);
      expect(a.roots).toEqual(b.roots);
      // ours must decode back to the same data
      expect(decodeSynthDefs(ours.bytes)[0]).toEqual(ours.data);
    });
  }
});
