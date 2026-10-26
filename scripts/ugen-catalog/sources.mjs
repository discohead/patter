// sources.mjs — extract the sclang source text of every constructor (and of overridden
// new1/init/initOutputs/checkInputs/numOutputs/etc.) for the probed classes, using the
// file + charPos recorded by probe.scd. Used for review and for `special` descriptions.
//   node sources.mjs probe_raw.jsonl > sources_review.txt
import fs from 'node:fs';
import readline from 'node:readline';

const fileCache = new Map();
const readFile = (p) => {
  if (!fileCache.has(p)) fileCache.set(p, fs.readFileSync(p, 'utf8'));
  return fileCache.get(p);
};

// return the method text starting at charPos: header up to the matching closing brace
export function methodSource(file, charPos) {
  const s = readFile(file);
  let i = s.indexOf('{', charPos);
  if (i < 0) return null;
  let depth = 0, j = i, inStr = null, inLineComment = false, inBlockComment = false;
  for (; j < s.length; j++) {
    const c = s[j], n = s[j + 1];
    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; j++; } continue; }
    if (inStr) { if (c === '\\') { j++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '/') { inLineComment = true; continue; }
    if (c === '/' && n === '*') { inBlockComment = true; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '$') { j++; continue; } // char literal
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) break; }
  }
  return s.slice(charPos, j + 1).replace(/^\s+/, '');
}

const GENERIC = new Set(['UGen', 'MultiOutUGen', 'PureUGen', 'PureMultiOutUGen', 'Meta_UGen', 'Meta_MultiOutUGen', 'AbstractFunction', 'Object']);

// a constructor is "trivial" if it is exactly ^this.multiNew('rate', <its args in order>)[.madd(mul, add)]
export function isTrivialCtor(src, argNames) {
  const body = src.replace(/\s+/g, ' ');
  const m = body.match(/\{\s*(?:arg [^;]*;|\|[^|]*\|)\s*\^\s*this\.multiNew\(\s*'(\w+)'\s*((?:,\s*[\w]+\s*)*)\)\s*(\.madd\(\s*mul\s*,\s*add\s*\))?\s*;?\s*\}$/);
  if (!m) return false;
  const passed = m[2].split(',').map((x) => x.trim()).filter(Boolean);
  const expect = argNames.filter((a) => !(m[3] && (a === 'mul' || a === 'add')));
  return passed.length === expect.length && passed.every((p, i) => p === expect[i]);
}

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(process.argv[2]) });
  const out = [];
  for await (const line of rl) {
    const d = JSON.parse(line);
    const parts = [];
    for (const [sel, m] of Object.entries(d.methods || {})) {
      if (!m.file || m.charPos == null) continue;
      const src = methodSource(m.file, m.charPos);
      const trivial = isTrivialCtor(src, m.argNames);
      if (!trivial) parts.push(`--- ${sel} (${m.owner})\n${src}`);
    }
    for (const [k, o] of Object.entries(d.owners || {})) {
      if (!o || GENERIC.has(o[0])) continue;
      if (['writeInputSpec', 'collectConstants', 'addToSynth', 'name', 'writeDef'].includes(k) && o[0] === 'UGen') continue;
      parts.push(`--- ${k} (${o[0]})\n${methodSource(o[1], o[2])}`);
    }
    if (parts.length) out.push(`===== ${d.class}  [${(d.superclasses || []).join(' < ')}]\n${parts.join('\n')}`);
  }
  console.log(out.join('\n\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
