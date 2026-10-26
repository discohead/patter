# patter

Describe a synthesis system out loud, the way you'd explain a patch to another
modular person, and get it running: oscillators into filters into VCAs,
envelopes and LFOs patched into whatever they modulate, clocks, sequencers and
shift registers driving it all, with the knobs you asked for. Then keep
talking to it while it plays. Swap a module, re-route a modulation, ask for a
"darkness" macro.

patter is an agent harness around **SuperSonic**, SuperCollider's `scsynth`
compiled to WebAssembly and running in an AudioWorklet. The agent's job is
translation: from your description of a system onto the things SuperCollider
is made of. It is not a "make me a dark techno track" generator; it assumes you
know what you want to build.

**Live at <https://datspace.fm>**, behind Cloudflare Access.

---

## Contents

- [The idea: go with the grain](#the-idea-go-with-the-grain)
- [Architecture](#architecture)
- [The patch language](#the-patch-language)
- [Modules](#modules)
- [Modulation and macros](#modulation-and-macros)
- [Subpatches and abstractions](#subpatches-and-abstractions)
- [Finding your way around](#finding-your-way-around)
- [Sessions, saving and stopping](#sessions-saving-and-stopping)
- [Routines (sequencing)](#routines-sequencing)
- [Inside the engine](#inside-the-engine)
- [The agent](#the-agent)
- [Running, deploying, security](#running-deploying-security)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Status and next steps](#status-and-next-steps)
- [Design notes](#design-notes)

---

## The idea: go with the grain

SuperCollider already *is* a modular system. Each idea below maps onto
something scsynth does natively, and patter adds as little of its own as it
can:

| You think in…                     | scsynth already has…                                         | patter's thin layer                                  |
|-----------------------------------|--------------------------------------------------------------|------------------------------------------------------|
| a module (osc, filter, VCA, LFO)  | a **SynthDef** running as a **synth node**                   | a named *module*: code → SynthDef → node             |
| a patch cable (audio)             | an **audio bus**; `Out.ar` / `InFeedback.ar`                 | `input('osc')` in module code                        |
| a CV cable with an attenuverter   | a **control bus** + **`/n_map`**                             | the modulation matrix (in-engine summing)            |
| a knob                            | a SynthDef **control** + **`/n_set`**                        | `param()` with a spec (range, warp, unit)            |
| a macro knob                      | a control bus written with **`/c_set`**                      | a modulation *source* the UI turns                   |
| signal flow order                 | the **node tree** (groups, execution order)                  | groups by role; audio modules topologically sorted   |
| hot-swapping a module             | JITLib's **Ndef** crossfade                                  | new node beside the old, fade envelopes, same bus    |
| a sequencer or clock              | **Demand** UGens in the engine, or **Routines** with timed OSC bundles | both; routines are JS generators on clockwork's clock |
| a polysynth voice                 | `/s_new` per note, `doneAction: 2`                           | *voice* modules, `play()` from routines              |

So the agent writes real SuperCollider graphs, with real UGens, real argument
orders, multichannel expansion, `Env`s and `doneAction`s. It uses JavaScript
syntax because JavaScript is what the browser runs.

---

## Architecture

```
 Browser (datspace.fm)                                         Cloudflare
┌──────────────────────────────────────────────────┐        ┌────────────────────────────────────┐
│ assistant-ui thread  ◀─ useAISDKRuntime          │        │ Worker  worker/index.ts            │
│        ▲                                         │  WS    │   Access JWT check → routeAgent…   │
│ useAgentChat / useAgent ─────────────────────────┼───────▶│                                    │
│        │ tool calls (client tools)               │        │ PatterAgent  (Durable Object)      │
│        ▼                                         │        │   AIChatAgent: history in SQLite   │
│ runTool()  src/agent/tools.ts ─┐                 │        │   streamText(DeepSeek, tools)      │
│                                ▼                 │        │        │                           │
│  Runtime ─ patch document ⇄ engine               │        │        ▼  createAI({ gateway })    │
│  Sequencer (routines) ─ timed OSC bundles        │        │   AI Gateway "patter"              │
│  Patch-language compiler: JS → UGens → SCgf      │        │        │                           │
│        │ /d_recv, /s_new, /n_map …               │        │        ▼                           │
│  SuperSonic: scsynth WASM in an AudioWorklet     │        │   Workers AI                       │
│  (SharedArrayBuffer transport, clockwork clock)  │        │   @cf/deepseek-ai/                 │
└──────────────────────────────────────────────────┘        │     deepseek-v4.1-flash-1017       │
                                                            └────────────────────────────────────┘
```

- **Everything that makes sound runs in the page:** the engine, the runtime,
  the sequencer and the compiler.
- **The agent runs in a Durable Object:** one per session, holding the
  conversation in SQLite.
- **Your patches live in another Durable Object**, `PatchLibrary`, one per
  Access identity, behind `/api/*`. It holds the named saves and every
  session's working patch.
- **All of patter's tools are client tools.** The model calls them in the
  Worker, the browser executes them against the live engine, and the
  Durable Object continues the turn when the results come back.
- **The patch document is the source of truth:** a JSON description of every
  module (code and knob values), route, macro and routine. The runtime turns
  edits to it into OSC. Saving, loading and undo all work on the document.

---

## The patch language

Module code is JavaScript run with sclang's signal semantics. The source is
parsed with [acorn](https://github.com/acornjs/acorn) and rewritten before it
runs:

- **Arithmetic and comparisons build UGens.** `a * b`, `a + b`, `a ** b`,
  `a < b` and `-a` become BinaryOp/UnaryOp UGens when a signal is involved,
  and plain JS math when both sides are numbers. JS precedence applies:
  `a + b * c` means what it looks like. sclang reads left to right; patter
  does not.
- **Method calls work on numbers and arrays as well as signals**, as in
  sclang: `(60).midicps()`, `[sigA, sigB].tanh()`, `sig.range(200, 2000)`,
  `[a, b, c].sum()`.
- **Arrays are multichannel signals.** `Saw.ar([100, 101])` is two saws, and
  `freq * [1, 1.01]` expands.
- **Keyword arguments** go in a trailing object:
  `EnvGen.kr(env, gate, { doneAction: 2 })`.
- **Loops are guarded**, so a runaway loop raises an error instead of
  freezing the page. Errors report the line they happened on.
- The last expression is the module's output (`return` works too).

| sclang                                         | patter                                              |
|------------------------------------------------|-----------------------------------------------------|
| `SinOsc.ar(440, 0, 0.1)`                       | `SinOsc.ar(440, 0, 0.1)`                            |
| `EnvGen.kr(Env.perc(0.01, 1), doneAction: 2)`  | `EnvGen.kr(Env.perc(0.01, 1), { doneAction: 2 })`   |
| `sig.tanh`, `freq.midicps`                     | `sig.tanh()`, `freq.midicps()`                      |
| `SinOsc.ar(f) ! 2`                             | `SinOsc.ar(f).dup(2)`                               |
| `` Klank.ar(`[freqs, nil, rings], in) ``       | `Klank.ar([freqs, null, rings], input)`             |
| `\cutoff.kr(1200, spec: \freq)`                | `param('cutoff', 1200, 'freq')`                     |
| `Ndef(\osc).ar`                                | `input('osc')`                                      |

**Every UGen the engine has** (377 classes: the core plugins plus
DistortionUGens and MdaPiano) is available by its sclang name. The catalog
(`src/sc/ugen-catalog.json`) was **extracted from sclang 3.14.1 itself**:

- every constructor was probed with sentinel values to see where each argument
  lands in the SynthDef;
- every method was then re-checked against sclang's own bytes.

It also records sclang's constructor quirks:

- Lag of a constant is the constant;
- Stepper's `resetval` defaults to `min`;
- delays convert control-rate inputs with `K2A`;
- `Dstutter` is really `Ddup`;
- and so on.

Alongside the quirks it carries each UGen's help summary, which the agent can
look up.

The compiler follows sclang where it matters for correctness and
efficiency:

- operator degenerate cases
- `MulAdd` and its rate rules
- sclang's topological sort, plus width-first ordering for FFT chains
- automatic `MaxLocalBufs`
- dead-code elimination that keeps side effects (any non-zero `doneAction`
  counts as one)
- automatic rate conversions where sclang would reject the graph

---

## Modules

A module is a named node proxy with its own bus.

| kind      | runs as                                 | output bus     | typical use                               |
|-----------|-----------------------------------------|----------------|-------------------------------------------|
| `audio`   | one persistent synth                    | audio, N ch    | oscillators, filters, VCAs, effects, mixers |
| `control` | one persistent synth                    | control, N ch  | LFOs, envelopes, clocks, sequencers, S&H  |
| `voice`   | a group; one synth *per note*           | audio, N ch    | polyphonic instruments played by routines |

```js
// module "osc" (audio)
const freq = param('freq', 110, 'freq');
const detune = param('detune', 0.12, [0, 1]);
Saw.ar(freq * [1, 1 + detune * 0.01]) * 0.3
```

```js
// module "seq" (control): named outputs, one channel each
const clock = Impulse.kr(param('rate', 4, [0.25, 32, 'exp']));
const pitch = Demand.kr(clock, 0, Dseq([36, 39, 43, 46, 48], inf));
({ pitch, gate: Trig1.kr(clock, 0.05) })
```

```js
// module "filter" (audio): reads osc's bus
MoogFF.ar(input('osc'), param('cutoff', 1200, 'freq'), param('res', 0.3, [0, 1]) * 3.5)
```

- **`param(name, default, spec?, opts?)`** declares a knob. The spec is a
  preset name (`'freq'`, `'lofreq'`, `'rq'`, `'amp'`, `'db'`, `'pan'`,
  `'rate'`, `'time'`, …, the same as sclang's `Spec.specs`), a tuple
  `[min, max, warp, step]`, or an object
  `{ min, max, warp, unit, lag, rate, label }`. Names starting `t_` are
  trigger-rate, `i_` initial-rate.
- **`input('osc')`** reads another module's bus; `input('seq.gate')` picks a
  named output, `input('osc.1')` a channel. The bus index travels in a
  control, so re-wiring never needs a recompile.
- **Hot-swap.** Redefining a module starts the new synth right after the old
  one on the same bus and crossfades. Audio crossfades are sine-shaped and
  control ones linear, so control values morph. Knob values carry over. If the
  output shape changes, modules that read it are recompiled.
- **Voices** are spawned per note by routines and must end themselves
  (`doneAction: 2`). A voice without such an envelope gets a gate envelope,
  with a warning.

---

## Modulation and macros

```
modulate('lfo', 'filter.cutoff', 0.4)      // source, target, amount
modulate('macro:dark', 'filter.cutoff', -0.6)
```

- **The amount is in knob-range units, in the parameter's own warp.** An
  amount of 0.4 on an exponential cutoff knob moves it across 40% of the
  knob's travel, not 0.4 Hz. Sources are normalised: LFOs bipolar ±1,
  envelopes and gates 0..1.
- **The knob sets the base; the routes add to it.** It all happens in the
  engine: each modulated parameter gets a `patter_modsum` synth (knob position
  plus up to 8 sources × amounts, clipped, mapped through the warp) that
  writes a bus the target control is `/n_map`ped to.
- **A macro is a modulation source the UI turns** (a control bus set with
  `/c_set`). "Darkness" is one macro routed to cutoff (−), resonance (+) and
  reverb mix (+). Macros can be bipolar.

---

## Subpatches and abstractions

Patches nest, as in Pd and Max. A **subpatch** is a named scope with an
interface (inlets, outlets, controls), so from outside it behaves like one
module:

```
voice                          a subpatch
  inlets    lfo ← lfo          fed from the parent scope (or unconnected: silence)
  outlets   out → vca          the first is the main one: input('voice') reads it
  controls  cutoff → filter.cutoff, pitch → osc.freq     its face
  osc, filter, env, vca        modules, by path: 'voice/osc'
```

- **Lexical scoping.** Inside `voice`, `input('osc')` finds the sibling
  `voice/osc`, or failing that the inlet `osc`. `'../x'` reads the parent
  scope, `'/x'` the top level, and `'voice/env'` reaches into a child. A
  subpatch with no declared outlets outputs the one module inside that nothing
  else inside reads.
- **Controls** put inner params (or macros) on the subpatch's face.
  `voice.cutoff` then works anywhere a param does: knobs, modulation targets,
  the Performance Panel, `knob()` in routines.
- **Ports are free.** A module's input buses are resolved where it lives and
  sent to its node as controls. Input controls are numbered, not named after
  the ref. So grouping, ungrouping, moving and re-patching an inlet only
  re-point cables. Rewriting `input('osc')` as `input('voice')` compiles to
  the same SynthDef, and the runtime keeps the node: nothing restarts.
- **Group and ungroup.** Select modules (shift-click or drag) and press ⌘G, or
  ask. The new subpatch gets an inlet for everything its members read from
  outside, named like the source so their code doesn't change, and an outlet
  for whatever outside reads; outside readers are rewritten to read it.
  Routes, macros, the Performance Panel and routine code follow the move.
  Ungroup is the exact inverse.
- **Abstractions.** Save a subpatch as a named abstraction and it becomes the
  first instance; instantiate more, each with its own inlet connections and
  knob values. Instances share one definition. In any instance you can:
  - redefine a module;
  - change a route, a macro or the interface;
  - group, ungroup or instantiate something.

  Every other instance follows, in place, still running. SynthDefs are named
  by content, so instances share them. Detach forks an instance. An
  abstraction used inside another is kept by reference, so editing the inner
  one reaches every copy.

---

## Finding your way around

- **The graph shows one level at a time**, like a patcher window.
  - Double-click a subpatch (or press ↵) to open it; esc or the breadcrumbs
    take you back up.
  - Inside, the subpatch's inlets run down the left and its outlets down the
    right.
  - Anything that reaches in without an inlet shows as a dashed "outside"
    node.
  - Every node has a live meter.
- **Click a node and the knob area switches to Selected**:
  - a module's knobs, plus the modulation routes into them, with amounts you
    can turn;
  - a subpatch's face and its insides;
  - a macro and its targets.
- **Click the background to return to the Performance panel.** It shows the
  top level's exposed controls, the face of the subpatch you're in, or, until
  you choose, everything at that level.
- **☆ on any knob** puts it on (or takes it off) the Performance Panel of the
  level you're in. Inside a subpatch, that builds the subpatch's face.
- **The right-hand panel follows the selection**:
  - a module's code (⌘↩ hot-swaps);
  - a subpatch's interface: re-patch an inlet from a menu, remove a control,
    save as an abstraction, detach, duplicate, ungroup.
- **Keys:** ⌘. stop and play · ⌘S save · ⌘O open · ⌘G group ·
  ⌘⇧G ungroup · ⌘D duplicate · ⌘A select all · ⌘Z / ⌘⇧Z undo and redo ·
  ↵ open · esc deselect, then up.
- **The agent sees where you are.** Each message carries your current scope
  and selection, so "make this darker" means the selection.

---

## Sessions, saving and stopping

- **A session is one conversation with the agent and the patch it's about.**
  - Its patch autosaves about a second after every change: to this browser,
    and to your patch library on the server.
  - Reload, or close and reopen the tab, and the start screen says which patch
    it will pick up. Click to start audio and the patch comes back, with the
    conversation, as you left it.
- **The patch title in the header is a menu.** A • next to the title means
  changes since the last save to the library.

  | item | what it does |
  |---|---|
  | Save (⌘S) | update the patch in your library |
  | Save as… | save it under a new name; the patch takes that title |
  | Open… (⌘O) | your saved patches, and your recent sessions |
  | Rename…, New patch, Clear patch | as named |
  | Import file…, Export file | JSON files |

- **Opening a saved patch, or starting a new one, starts a fresh
  conversation.** The session you leave stays under *Recent sessions*, patch
  and conversation together, so nothing is lost. Clear patch empties the
  patch and keeps talking (⌘Z undoes it).
- **Stop, with ■ or ⌘. (SuperCollider's own), stops everything:**
  - the agent's turn;
  - the routines;
  - the sound: the master fades and the node tree freezes.

  ▶ (or ⌘. again) picks up exactly where it stopped. While stopped, edits
  still apply, and the agent knows the sound is stopped.
- **Tool calls never start audio by themselves.** After a reload in the middle
  of a turn, the agent's waiting actions run once you've clicked start and the
  patch is back, or not at all if you say so. Calls a stopped turn hadn't run
  stay stopped, even across reloads.

---

## Routines (sequencing)

The body of a JavaScript generator; `yield n` waits *n* beats (sclang's
`Routine`/`Tdef`):

```js
// routine "melody": a Turing-machine line in a pentatonic scale
const reg = turing(8, 0.15);
const accents = euclid(5, 16);
let i = 0;
while (true) {
  play('pluck', { note: degree(Math.floor(reg.next() * 10), 'minorPentatonic', 48), dur: 0.25, amp: accents[i++ % 16] ? 0.25 : 0.12 });
  yield 0.25;
}
```

- Everything is stamped with its **logical beat**. The beat is converted to
  NTP time through clockwork's session clock and sent about 150 ms ahead as a
  timed OSC bundle, so the timing is the engine's.
- **`play(voice, args)`** starts a voice (`note` becomes `freq`; `dur × legato`
  schedules the release).
- **`set(module, args)`** sends timed `/n_set` to a persistent module.
- **`knob(ref, v)`** and **`macro(name, v)`** automate the UI.
- Replacing a routine swaps it on its next `quant` boundary.
- Helpers: `seq`, `rand`, `xrand`, `white`, `brown`, `markov`, `turing`,
  `euclid`, `degree`, `quantize`, `chord`, `SCALES`, `rrand`, `exprand`,
  `coin`, `choose`, `wchoose`, `shuffle`.

Sequencing can also live entirely in the engine (clocks, `Demand`, `Duty`,
`Stepper`, `PulseDivider`, `TRand`, `Latch` modules on control buses),
sample-locked and immune to page jank. `LinkPhase.kr(4)` reads the session
clock inside a SynthDef.

---

## Inside the engine

```
root (0)
└── patter (1)
    ├── control    (10)  control modules: LFOs, sequencers, envelopes, clocks
    ├── modulation (11)  patter_modsum per modulated param
    ├── audio      (12)  audio modules + voice groups, topologically ordered
    ├── monitor    (13)  patter_monitor_N: module bus → stereo → master mix (+ meter)
    └── master     (14)  patter_master: LeakDC → level → Limiter → out 0 (+ meter)
```

- Audio inputs use `InFeedback`, so even feedback loops between modules work,
  with one block of delay.
- `patter_probe_*` copies any bus into a `ScopeOut2` slot. That is how the
  agent's `listen` hears a module.
- Every system SynthDef is written in the patch language and compiled at boot.
- SynthDef loads wait for the engine's answer, so a refused definition fails
  loudly at define time.

---

## The agent

DeepSeek V4.1 Flash (`@cf/deepseek-ai/deepseek-v4.1-flash-1017`) on Workers
AI, through the `patter` AI Gateway:

- **Model:** 1M-token context, function calling, and `reasoning_effort`, which
  is set from the settings panel as off, low or high.
- **Caching:** session affinity keeps a conversation on one backend for
  prefix-cache hits on the long system prompt.
- **Gateway:** logs every call and rate-limits to 120 requests per minute.

The **system prompt** (`src/agent/prompt.ts`) covers:

- the substrate;
- the patch language and its gotchas;
- modulation conventions;
- engine-versus-routine sequencing;
- gain-staging craft;
- worked examples;
- the full UGen index.

Each user message carries a `<patch_state>` snapshot, so knob moves you make by
hand are visible to it.

Its 20 tools (`src/agent/tool-defs.ts`):

| tool | what it does |
|---|---|
| `define_module` | create or hot-swap a module (code, kind, initial params) |
| `remove_module` | fade out and remove |
| `subpatch` | group, ungroup, configure (inlets, outlets, controls), duplicate, remove |
| `abstraction` | save a subpatch as an abstraction, instantiate it, detach an instance, list |
| `set_params` | turn knobs and macros |
| `modulate` | add, change or remove routes |
| `define_macro` / `remove_macro` | macro knobs with per-target amounts |
| `define_routine` / `routine_control` | sequencing in the language |
| `set_tempo` | session BPM |
| `mix` | play/level/pan/mute per module, master level |
| `expose_controls` | which knobs the control surface shows, labelled and grouped |
| `listen` | record a module's bus: peak/RMS, DC, clipping, centroid/rolloff/flatness, partials, pitch, a 50 ms envelope, pulse rate; per-channel stats for control signals |
| `graph` | **the patch as a Mermaid flowchart** (subpatches as nested subgraphs, cables, routes with amounts, macros, sends) plus the engine's execution order, for the whole patch or one subpatch, to a chosen depth; or, for one module, **its compiled UGen netlist**, which shows exactly what the code became |
| `trace` | scsynth's `/n_trace`: every UGen's live input and output values in a running node |
| `inspect` | the patch, a module (code, routes, readers), a subpatch (interface, what its inlets resolve to, what's inside), routines, engine log, node tree |
| `ugen_reference` | catalog entries and help text |
| `clear_patch`, `annotate` | start over; title and notes |

Compile errors, engine refusals and routine failures come back as tool
results, so the agent debugs its own patches. In testing, from a one-sentence
description it built `osc → filter`, patched `lfo → filter.cutoff`, listened,
rebalanced the gain, listened again, exposed five labelled controls and
reported a patch sheet, in about 36 seconds.

---

## Running, deploying, security

```bash
npm install          # also copies SuperSonic's workers/wasm/synthdefs into public/
npm run dev          # Vite + Cloudflare plugin: http://localhost:5317
npm test             # unit + golden tests
npm run deploy       # cf deploy → datspace.fm
```

- **`npm run dev`** runs the Worker and Durable Object locally in workerd.
  Workers AI is a remote binding, so local dev calls the real model (you need
  to be signed in with `cf auth login`). Access checks are off in development
  mode.
- **SuperSonic needs a cross-origin isolated page** for its SAB transport. The
  dev server sends COOP/COEP headers, and `public/_headers` sets them on every
  production asset.
- **Configuration** lives in `cloudflare.config.ts` (the `cf` CLI's typed
  config). It covers:
  - the two Durable Object exports, `PatterAgent` and `PatchLibrary` (SQLite);
  - the Workers AI binding;
  - the `datspace.fm/*` route, with `/agents/*` and `/api/*` running the
    Worker first;
  - the Access settings.

**Security.** The agent spends money, so it is locked down:

1. The Cloudflare Access application "patter (datspace.fm)" (self-hosted,
   hostname-based, so it covers the agent WebSocket) allows only
   `jaredcolin@gmail.com`. Everything on datspace.fm, page and agent alike,
   redirects to the Access login first.
2. The Worker verifies the Access JWT on every `/agents/*` and `/api/*`
   request: the signature against the team's certs, the audience, the expiry,
   the issuer and the email allowlist. Nothing that bypassed Access could use
   the agent or read the library. The library is keyed by the verified email.
   Writes must be JSON, which forces a CORS preflight that other sites can't
   pass.
3. `workers.dev` and preview URLs are disabled. They are the usual way around a
   hostname-based Access app.

---

## Testing

- **Golden tests against sclang.** `test/golden/cases.json` holds 33 graphs,
  each written once in sclang and once in the patch language. `npm run golden`
  compiles the sclang side with the real `sclang`. The tests compile the
  patch-language side and compare the two semantically: side-effect roots
  hashed as Merkle DAGs, with commutativity, `MulAdd`/`Sum3`/`Sum4` and
  `a - b ≡ a + neg(b)` normalised, and every param and default checked. All
  pass. The SCgf codec also round-trips every reference byte for byte.
- **Browser smoke tests** (headless Chromium):
  - `node scripts/smoke.mjs` boots the engine, builds a patch through the
    agent's own tools, and listens to it.
  - `node scripts/smoke-agent.mjs "<description>" ["<follow-up>" …]` runs the
    whole agent loop against the dev server, one prompt after another.
  - `node scripts/smoke-hierarchy.mjs` groups, abstracts and edits a patch
    through the tools and drives the graph UI (select, open, ⌘G, ⌘Z, ☆),
    with screenshots.
  - `node scripts/smoke-library.mjs` covers sessions and the library: autosave,
    restore across a reload, ⌘. stop and play, save, save as, open, recent
    sessions, delete, import, and clear with undo.
  - `node scripts/smoke-resume.mjs` runs the real agent across a reload in the
    middle of a turn, and a ⌘. in the middle of one.
- **Runtime tests** (`test/hierarchy.test.ts`, against a fake engine): scoping,
  grouping and ungrouping without restarting nodes, subpatch controls,
  abstraction edits reaching every instance, nested abstractions by
  reference, duplicate, save and load.
- sclang runs with `HOME` pointed at an empty directory, so your
  `startup.scd` (which boots SuperDirt) is never loaded.

---

## Project layout

```
src/
  sc/                     the SuperCollider side, no browser APIs
    ugen.ts               graph model: UGen, Sig, operators, MulAdd, multichannel expansion
    catalog.ts            catalog-driven constructors (args, kwargs, input order, sclang quirks)
    ugen-catalog.json     extracted from sclang 3.14.1 by probing; verified against sclang bytes
    special.ts            Klank, Klang, LocalBuf, and pseudo-UGens (Mix, Splay, PMOsc, SelectX…)
    methods.ts            range, exprange, linlin, linexp, lincurve, clip/fold/wrap, lag, poll
    env.ts, ops.ts        Env; operator indices and constant folding
    synthdef.ts           finish (controls, DCE, topo sort) + SCgf v2 encode/decode
    dsl.ts, scope.ts      acorn transform; the names patch code can use
  runtime/
    module-def.ts         module code → SynthDef: param(), input(), fades, voices
    runtime.ts            patch document ⇄ engine: hot-swap, wiring, subpatches, abstractions, modsums, macros, monitors, undo, listen
    resolve.ts            lexical name resolution in the hierarchy (refs, params, macros, implicit outlets)
    graph.ts              one level as a graph (for the UI), Mermaid diagrams, node order, UGen netlists
    patch.ts, specs.ts    PatchDoc types; ControlSpec presets and warps
  engine/                 SuperSonic boot, groups, buses, meters, scopes, trace; analysis; system SynthDefs
  seq/                    routines (generators on the session clock) and musical helpers
  agent/
    tool-defs.ts          the 20 tool schemas (shared with the Worker)
    tools.ts              their browser-side execution
    prompt.ts             the system prompt (+ UGen index)
  app/                    the store (sessions, autosave, transport, focus) and the library client
  ui/                     assistant-ui thread + push-to-talk, patcher graph, Performance/Selected panels, inspector, knobs, patch menu
worker/
  index.ts                Access check, then /agents/* (routeAgentRequest) or /api/*
  agent.ts                PatterAgent: AIChatAgent → DeepSeek via AI Gateway, client tools
  library.ts, api.ts      PatchLibrary (named saves + session patches) and its HTTP API
  access.ts               Access JWT verification
cloudflare.config.ts      Worker, Durable Object, bindings, route (cf CLI)
scripts/                  copy-supersonic, golden (sclang), smoke tests
test/                     unit, golden, netlist tests
```

---

## Status and next steps

Working and tested:

- the compiler (golden-tested against sclang)
- runtime, modulation, macros, routines and the analysis tools
- subpatches, abstractions, the patcher-style graph and the Performance /
  Selected panels
- the agent loop end to end, both locally and deployed to datspace.fm behind
  Access

Ideas next:

- **fuse**: compile a subpatch into one SynthDef by inlining its modules'
  graphs, so a whole subpatch can be played polyphonically as a voice
- MIDI and OSC out
- render Mermaid diagrams in chat (the agent already produces them)
- live modulation rings on the knobs
- MIDI controllers on knobs (SuperSonic has Web MIDI)
- samples (Sonic Pi's pack is on the CDN)
- patch sharing
- Strudel/Tidal mini-notation for routines
- an MCP bridge so Claude Code can drive the same tools

---

## Design notes

- **Why JavaScript and not sclang syntax?** The browser runs JS and models
  write it fluently. Operator overloading through an AST rewrite gives sclang's
  signal semantics with ordinary precedence, while UGen names, argument
  orders, rates and multichannel rules stay sclang's.
- **Why per-module synths and not one big SynthDef per patch?** Hot-swap,
  re-patching and modulation routing happen without recompiling the world, and
  every module is addressable by name, which is how you talk about a patch.
- **Why aren't subpatches nested SynthDefs?** scsynth can't nest SynthDefs
  at run time. Subpatches are structure (scopes, names and bus wiring over
  per-module nodes), which keeps every module live-editable and addressable.
  Fusing a subpatch into one SynthDef is the planned complement, for
  polyphony.
- **Why client tools?** The engine lives in the page; the model lives on
  Cloudflare. Tools run where the sound is, and the Durable Object holds the
  conversation and resumes the turn when results come back.
- **Licensing.** SuperSonic is AGPL-3.0-or-later. Serving patter publicly
  would carry AGPL obligations; this deployment is private, behind Access.
