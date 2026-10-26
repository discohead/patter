import fs from 'node:fs';
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const only = process.argv[3] ? new RegExp(process.argv[3]) : null;
const fmtIn = (x) => x.k === 'num' ? String(x.v) : x.k === 'proxy' ? `${x.cls}#${x.idx}[${x.out}]` : x.k === 'ugen' ? `${x.cls}#${x.idx}` : `?${x.cls}`;
const fmt = (ch) => ch.map((c, i) => `  ${i}: ${c.cls}${c.op ? '(' + c.op + ')' : ''} ${c.rate} out=${c.numOutputs}${c.special ? ' sp=' + c.special : ''} [${c.inputs.map(fmtIn).join(', ')}]`).join('\n');
for (const r of rows) {
  if (only && !only.test(r.name)) continue;
  console.log(`== ${r.name}  ret=${JSON.stringify(r.raw.ret)}${r.raw.err ? '  ERR=' + r.raw.err : ''}`);
  console.log(fmt(r.raw.children));
  if (r.finished) {
    console.log(`  -- finished${r.finished.err ? ' ERR=' + r.finished.err : ''}`);
    if (r.finished.children) console.log(fmt(r.finished.children));
  }
}
