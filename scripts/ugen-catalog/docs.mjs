// docs.mjs — short human docs (summary, category, per-argument text) for a UGen class,
// parsed from its .schelp file; falls back to packages/defsynth metadata.json.
import fs from 'node:fs';
import os from 'node:os';

const HELP_DIRS = [
  '/Applications/SuperCollider.app/Contents/Resources/HelpSource/Classes',
  `${os.homedir()}/Library/Application Support/SuperCollider/Extensions/SC3plugins/DistortionUGens/HelpSource/Classes`,
  `${os.homedir()}/Library/Application Support/SuperCollider/Extensions/SC3plugins/MdaUGens/HelpSource/Classes`,
];
// Fallback docs from the SuperSonic repo's (unpublished) defsynth package, when it is checked out next door.
const METADATA = process.env.DEFSYNTH_METADATA ?? new URL('../../../supersonic/packages/defsynth/src/ugens/metadata.json', import.meta.url).pathname;

let md = null;
const metadata = () => (md ??= JSON.parse(fs.readFileSync(METADATA, 'utf8')).ugens);

// strip schelp inline markup to plain text
export function plain(s) {
  return s
    .replace(/link::([^:]*?)(?:#[^:]*)?::/g, (_, l) => l.split('/').pop().replace(/#.*$/, ''))
    .replace(/(?:code|strong|emphasis|teletype|soft|anchor)::(.*?)::/gs, '$1')
    .replace(/\b(?:code|strong|emphasis|teletype|soft|note|warning|footnote|image|table|list|tree|numberedlist|definitionlist)::/g, '')
    .replace(/##|\|\||::/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// first one or two sentences, capped (a sentence ends at . ! ? followed by space+capital/end,
// so decimals like "1.0" or "0.8)" do not split)
export function brief(s, maxSentences = 2, maxLen = 220) {
  if (!s) return undefined;
  const t = plain(s);
  if (!t) return undefined;
  const parts = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    cur += t[i];
    const abbrev = /(?:\be\.g|\bi\.e|\betc|\bvs|\bcf)\.$/i.test(cur.slice(-5));
    if (/[.!?]/.test(t[i]) && !abbrev && (i === t.length - 1 || /\s/.test(t[i + 1]) && /[A-Z(]/.test(t.slice(i + 1).trimStart()[0] || ''))) {
      parts.push(cur.trim()); cur = '';
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  let out = '';
  for (const p of parts.slice(0, maxSentences)) {
    const next = (out + ' ' + p).trim();
    if (next.length > maxLen && out) break;
    out = next;
  }
  if (out.length > maxLen) out = out.slice(0, maxLen - 1).replace(/\s+\S*$/, '') + '…';
  return out;
}

export function parseSchelp(text) {
  const lines = text.split(/\r?\n/);
  const res = { summary: undefined, category: undefined, args: {} };
  let inClassMethods = false, curArg = null, buf = [];
  const flush = () => {
    if (curArg && !(curArg in res.args)) res.args[curArg] = buf.join('\n');
    curArg = null; buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z]+)::\s*(.*)$/);
    if (m) {
      const tag = m[1].toLowerCase(), rest = m[2].trim();
      if (['argument', 'method', 'returns', 'discussion', 'section', 'subsection', 'examples', 'instancemethods', 'classmethods', 'description', 'private', 'copymethod'].includes(tag)) flush();
      if (tag === 'summary') res.summary = rest;
      else if (tag === 'categories') res.category = rest.split(',')[0].trim();
      else if (tag === 'classmethods') inClassMethods = true;
      else if (tag === 'instancemethods' || tag === 'examples') inClassMethods = false;
      else if (tag === 'argument' && inClassMethods) { curArg = rest.split(/\s+/)[0]; buf = []; }
      else if (curArg) buf.push(line);
      continue;
    }
    if (curArg) buf.push(line);
  }
  flush();
  return res;
}

const MANUAL = {
  LinkTempo: {
    summary: 'Session tempo of the SuperSonic/clockwork transport (Ableton Link when active), in beats per second (bpm/60).',
    category: 'UGens>SuperSonic',
    args: { gate: 'Ignored by the SuperSonic implementation (the tempo-setting side was removed).', tempo: 'Ignored by the SuperSonic implementation.' },
  },
  LinkPhase: {
    summary: 'Beat phase of the SuperSonic/clockwork transport within a quantum, in [0, quantum).',
    category: 'UGens>SuperSonic',
    args: { quantum: 'Quantum length in beats (min 1e-6).' },
  },
  Pitch: {
    args: {
      in: 'Input signal.', initFreq: 'Frequency output until a pitch is first found.', minFreq: 'Lowest frequency detected.',
      maxFreq: 'Highest frequency detected.', execFreq: 'How often (Hz) the tracker runs; clipped to [minFreq, maxFreq].',
      maxBinsPerOctave: 'Coarse autocorrelation lags per octave (search speed, not resolution).',
      median: 'Median filter length on the estimate (1 = none).', ampThreshold: 'Minimum peak-to-peak input amplitude for tracking.',
      peakThreshold: 'Autocorrelation peak threshold relative to the zero-lag peak.',
      downSample: 'Integer input down-sampling factor (less CPU, less resolution).', clar: 'If > 0, hasFreq becomes a 0..1 clarity measure.',
    },
  },
  ScopeOut2: { summary: 'Writes signals into a shared scope buffer (used by the SuperCollider scope).', category: 'UGens>Buffer',
    args: { inputArray: 'Signals to write.', scopeNum: 'Scope buffer index.', maxFrames: 'Scope buffer size in frames.', scopeFrames: 'Frames to use (nil = maxFrames).' } },
  ClearBuf: { summary: 'Zeroes a buffer (typically a LocalBuf) when the synth starts.', category: 'UGens>Buffer', args: { buf: 'Buffer to clear.' } },
  SetBuf: { summary: 'Writes values into a buffer (typically a LocalBuf) when the synth starts.', category: 'UGens>Buffer',
    args: { buf: 'Buffer to set.', values: 'Values to write.', offset: 'Start index in the buffer.' } },
  BlockSize: { summary: 'Server block size (samples per control period), scalar rate.', category: 'UGens>Info' },
  NodeID: { summary: 'Node ID of the running synth, scalar rate.', category: 'UGens>Info' },
  AudioControl: { summary: 'Internal: audio-rate SynthDef controls (created for audio-rate arguments / NamedControl.ar).', category: 'UGens>Synth control' },
};

export function docsFor(className, argNames) {
  let summary, category;
  const args = {};
  const man = MANUAL[className] || {};
  for (const [k, v] of Object.entries(man.args || {})) args[k] = v;
  summary = man.summary; category = man.category;
  if (!man.summary || !man.category || !man.args) {
    for (const dir of HELP_DIRS) {
      const p = `${dir}/${className}.schelp`;
      if (fs.existsSync(p)) {
        const d = parseSchelp(fs.readFileSync(p, 'utf8'));
        summary ??= d.summary; category ??= d.category;
        for (const [k, v] of Object.entries(d.args)) if (!(k in args) && v.trim()) args[k] = v;
        break;
      }
    }
    const m = metadata()[className];
    if (m) {
      summary ??= m.summary;
      category ??= m.categories?.split(',')[0]?.trim();
      for (const a of m.args || []) if (a.doc && !(a.name in args)) args[a.name] = a.doc;
    }
  }
  const argDocs = {};
  for (const n of argNames) {
    const t = brief(args[n]);
    if (t) argDocs[n] = t;
  }
  return { summary: brief(summary, 2, 200), category, argDocs };
}
