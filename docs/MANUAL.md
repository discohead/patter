# patter: the manual

*The serious one. For the version with jokes, see the [README](../README.md).*

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
- [Sets, songs, sessions and branches](#sets-songs-sessions-and-branches)
- [The mixer, recording and capture](#the-mixer-recording-and-capture)
- [Samples](#samples)
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
  conversation and its checkpoints in SQLite.
- **Your library lives in another Durable Object**, `PatchLibrary`, one per
  Access identity, behind `/api/*`. It holds your AGENTS.md, sets, songs and
  every session's place and latest patch.
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
- **Keys:** ⌘. stop and play · ⌥R (or F9) record · ⌥C capture · ⌘S keep a
  checkpoint · ⌘O find a session · ⌘\\ the library · ⌘G group · ⌘⇧G ungroup ·
  ⌘D duplicate · ⌘A select all · ⌘Z / ⌘⇧Z undo and redo · ↵ open · esc
  deselect, then up.
- **The agent sees where you are.** Each message carries your current scope
  and selection, so "make this darker" means the selection.

---

## Sets, songs, sessions and branches

The library is organised like directories, and none of it is imposed:

```
AGENTS.md                yours: every session reads it
◇ a set/                 a set list of songs, with its AGENTS.md
    ♫ a song/            its AGENTS.md, and its sessions
        ● a session      one conversation and the patch it's about
            ⑂ a branch   of that session, from some message
♫ a song on its own/
● a session on its own   start here, file it whenever (or never)
```

- **A session is one conversation with the agent and the patch it's about.**
  - Its patch autosaves about a second after every change: to this browser,
    and to your library on the server.
  - Reload, or close and reopen the tab, and the start screen says which patch
    it will pick up. Click to start audio and the patch comes back, with the
    conversation, as you left it.
- **The library is on the left** (☰ or ⌘\\ shows and hides it; ⌘O finds a
  session by name):
  - ＋ New session starts an empty one at the top, free to explore;
  - ♫＋ makes a song and ◇＋ a set;
  - drag a session onto a song to file it, and a song onto a set (or onto
    another song, to put it there in the set list);
  - drop either on *sessions* to take it out;
  - each row's ⋯ renames, moves, branches or deletes, and a double-click
    renames.
  - Deleting a song or set can keep what's in it, moved up a level.
- **AGENTS.md files are context.** Yours applies to every session; a set's to
  every song in it; a song's to every session in it. Each is a row in the tree:
  click it to edit.
  - The agent reads the layers that apply to its session (its place, plus
    the titles of the other sessions in its song) at the end of its system
    prompt.
  - Ask it to remember something ("this song is in D minor at 92") and it
    appends it to the song's AGENTS.md with its `context` tool.
  - In testing it followed a song's AGENTS.md unprompted, setting 92 bpm and
    tuning a drone to D.
- **Every message is a checkpoint**, and every turn is one more:
  - the agent keeps the patch as it was when each of your messages was sent
    (its 'before');
  - the chat keeps it as each turn left it (its 'after', the ◆ under the
    answer);
  - ⌘S keeps the patch as it is now, by name, in the timeline (◆ checkpoint
    in the chat bar names it).
- **Branch from anywhere** (assistant-ui's action bars, on hover):
  - *✎ edit* one of your messages, or *↻ retry* it: a new session starts with
    the conversation up to there and the patch as it was when the message was
    sent, and the message goes there instead;
  - *⑂ branch from here* under an answer: a new session with the conversation
    through that turn and the patch as the turn left it;
  - *⑂ branch* on a checkpoint: from that patch.

  The session you branched from stays as it was. Where sessions go different
  ways, **‹ n/m ›** on the message flips between them, patch and all. The
  library nests branches under the session they came from.
- **⟲ restore** under an answer (or on a checkpoint) brings that patch back
  into this session; ⌘Z takes it away again.
- **The chat bar:**
  - ＋ new: an empty session, in the same song;
  - ⌫ clear: clear the conversation; a fresh session with this patch, which
    keeps playing, untouched;
  - ⑂ branch: a copy that goes its own way;
  - ◆ checkpoint.
- **The session title at the top is a menu**, after its place (set / song /):
  - rename;
  - keep a checkpoint;
  - branch, clear the conversation, or a new session;
  - file it in a song (or make one);
  - import or export a patch file;
  - clear the patch (⌘Z undoes);
  - delete.

  Clicking the set or song name opens its AGENTS.md.
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
- **Saved patches from before sets and songs** became sessions of their own at
  the top level, so nothing saved was lost.

---

## The mixer, recording and capture

**The Mixer tab** has a strip for every module that plays into the master.
Strips appear and disappear with the modules, grouped by the subpatch they're
in, and the master's strip comes last. Each strip has:
- a fader: the module's level into the mix, from −∞ to +6 dB, with 0 dB three
  quarters of the way up;
  - drag it (shift for fine), use the wheel or arrow keys, double-click for
    0 dB, or double-click the readout to type a value;
- pan, mute and solo (⌥-click solo to solo only that strip);
- a post-fader peak meter with peak hold, on the fader's own scale.

The faders aren't knobs: they're not modulation targets and not on any panel.
They're the person's final mix, and the agent leaves them alone unless asked:
- the `mix` tool's description and the system prompt say so;
- redefining a module keeps its fader and pan;
- each change on the mixer reaches the agent as a user action ("mixer: pad
  at −6.0 dB").

While anything is soloed, only soloed modules are heard. Solos are saved with
the patch.

**● REC** (⌥R, or F9) records the mix, from the master's output (what you
hear):
- the first press arms it for the next bar line;
- the second ends it on the bar line after, so a take is whole bars and loops;
- a press that lands just after a bar line (within 100 ms) means that bar
  line, because hands are a little late;
- a third press, while it waits to end, ends it there;
- pressed while the sound is stopped, it starts the sound too;
- ⌘. ends a recording where it is.

**⟲ Capture** (⌥C) saves the last few minutes of the mix whenever you press
it, because it has been listening all along:
- set how many minutes in Settings (1 to 20 minutes, about 23 MB of memory
  a minute);
- silence at either end is trimmed;
- while the sound is stopped the buffer doesn't fill with silence, so a
  capture after a pause still finds what you played before it.

**Takes** (recordings and captures) are kept in this browser (IndexedDB) as
they're made, two seconds at a time:
- they survive a reload, even one in the middle of a recording;
- each one downloads as a 24-bit WAV, named after the patch and the take;
- one can come into the patch as a sample (a whole-bar take knows its beats,
  so QLoop loops it);
- the Recordings tab plays them back, renames them and deletes them.

How recording works:
- **The tap.** An AudioWorklet of patter's own (`public/worklets/patter-tap.js`)
  sits beside the speakers. It sends the engine's output to the page in
  ~85 ms chunks, each stamped with its AudioContext frame. A ring keeps the
  last N minutes of them, and recordings read their frames out of that ring.
  That's how a recording can begin a moment in the past.
- **Bar lines.** They come from the client clock that routines are scheduled
  on. A beat's NTP time maps to an AudioContext frame:
  `frame = (ntp − nowAt(0)) × sampleRate`.
- **The limiter.** The master limiter's lookahead delays everything by 20 ms
  (960 frames at 48 kHz). The recorder allows for it, and the limiter's bypass
  path is delayed to match. Measured, a take's bar clicks land within about
  2 ms of its bar lines.

---

## Samples

Audio files are patch resources, like buses. A sample has a name in the
patch, and module code plays it with `sample('name')`.

**Getting audio in**
- Drag files anywhere onto the page. Each one joins the patch under its file
  name and is uploaded to your library: an R2 bucket, keyed by the file's
  SHA-256, behind Access like everything else. A session finds its
  samples again in any browser.
- Sonic Pi's pack of 206 CC0 samples is served from `/samples`: drums, loops,
  ambient, bass, tabla and more.
- **Record** (the Samples tab, or the agent) captures N bars of any module,
  subpatch or the whole mix into a new sample, starting exactly on the next
  bar line. The recording is precisely that many beats long, so it loops
  perfectly: record, loop, mangle, record again.

**Analysis.** Each sample is analysed in the browser when it loads:
- loudness;
- onsets (spectral flux);
- a tempo, with the whole-beat counts the file could span;
- a pitch (YIN).

A loop gets its beat count and a pitched one-shot its root note
automatically. Both can be changed on the sample's card.

**The players**

| | for | built on |
|---|---|---|
| `OneShot.ar(s, {…})` | hits: rate, pitch, note (from the root), start, reverse; ends a voice when done | PlayBuf |
| `QLoop.ar(s, {…})` | the fully quantized looping buffer (below) | BeatPhase + BufRd, or Warp1 |
| `Slice.ar(s, {…})` | one of N equal slices, from a routine or a trigger | BufRd with 2 ms edges |
| `Grains.ar(s, {…})` | grain clouds from any sample, stereo included | 8 round-robin BufRd grain voices |
| `BeatPhase.ar(q)` | the transport's beat at audio rate, for your own clock-locked playheads | Phasor, corrected each beat |

**QLoop.** It plays the sample's beats locked to the transport, at any
tempo. Every setting is quantized twice: in value, and in time (changes land
on the next `quant` boundary).
- **Values:**
  - start snaps to a beat grid;
  - length to powers of two;
  - rate to quarter steps (0 freezes);
  - reverse is on or off;
  - pitch, in stretch mode, snaps to the degrees of any scale: steps in
    semitones (fractions for microtonal), repeating every period.
- **Seamless by construction:** the playhead is a pure function of the
  transport, so every combination of knob positions is a seamless loop in
  time. Macros, modulation and routines can move them freely.
- **Modes:** tape reads the buffer, so rate is the pitch; two read heads
  crossfade over every jump, so it never clicks. Stretch granulates it with
  Warp1, so pitch and time move apart.
- **Timing:** by default the loop is locked to the transport, so a setting
  always plays the same audio at the same bar. `retrigger` restarts it at
  each change instead.
- **The view:** select a QLoop module and the Selected panel shows the
  waveform, the loop region and the moving playhead.

**Swapping audio.** Putting new audio under a sample's name reaches every
module playing it at once, without a restart, when the channel count is the
same. The SynthDef depends only on the channel count; the buffer number, the
beat count and the root note arrive as controls. Abstractions give samples
slots, so each instance plays its own.

**The session clock.** `LinkPhase` in SuperSonic 0.91 can sit a constant
offset away from the beat grid the client schedules on. Measured here it was
about a third of a second, varying between boots. So patter measures it:
- probe synths fire at known client times, at boot, after every tempo change,
  and every 15 s;
- the offset goes on a reserved control bus;
- `QLoop`, `BeatPhase`, the recorder and patter's own `LinkPhase` subtract it.

Engine-clocked loops and routines therefore share bar lines, to within an
audio block.

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

Its 22 tools (`src/agent/tool-defs.ts`):

| tool | what it does |
|---|---|
| `define_module` | create or hot-swap a module (code, kind, initial params) |
| `remove_module` | fade out and remove |
| `subpatch` | group, ungroup, configure (inlets, outlets, controls), duplicate, remove |
| `abstraction` | save a subpatch as an abstraction, instantiate it, detach an instance, list |
| `samples` | browse the stock pack and the library, add, set beats/root/audio, analyze, record bars into a new sample, remove |
| `context` | read the AGENTS.md files the session reads (its song's, its set's, the person's), and append to or rewrite one when asked to remember something |
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
  - `node scripts/smoke-library.mjs` covers sessions and the library:
    - autosave, and restore across a reload;
    - ⌘. stop and play;
    - ⌘S checkpoints;
    - a new session and back through the library, ⌘O to find one;
    - rename, filing in a song, import;
    - clear with undo;
    - delete (and a late autosave not bringing it back).
  - `node scripts/smoke-sessions.mjs` runs the real agent through sets, songs
    and branches:
    - a set and a song, and a session dragged into the song;
    - the song's AGENTS.md reaching the agent;
    - checkpoints before and after a turn;
    - branching from an answer, and editing a message into a new branch;
    - ‹ n/m › flipping back;
    - clear (the patch plays on), ⌘S, restore and undo;
    - a reload coming back to the same place.
  - `node scripts/smoke-resume.mjs` runs the real agent across a reload in the
    middle of a turn, and a ⌘. in the middle of one.
  - `node scripts/smoke-samples.mjs` covers the samplers in the engine:
    - the pack and analysis;
    - QLoop in both modes, its playhead against the transport, and a
      quantized change landing on the beat;
    - routine events landing on whole beats of the engine clock;
    - OneShot voices, Slice and Grains;
    - swapping audio without a restart;
    - a one-bar recording that comes back exactly a bar long, with its clicks
      on the beats.
  - `node scripts/smoke-samples-ui.mjs` drives the Samples tab and the loop
    view, drops a file onto the page (it reaches R2), and checks a reload
    brings everything back.
  - `node scripts/smoke-record.mjs` covers mixing and recording:
    - the Mixer's strips, a fader drag, solo and mute;
    - ⌥R from bar line to bar line (the take is whole bars, with its bar
      clicks at 0, 1, 2… bars), and ⌘. ending a take off the grid;
    - ⌥C capture, the WAV download, takes surviving a reload, and a take
      becoming a sample.
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
    samplers.ts           OneShot, QLoop, Slice, Grains, BeatPhase, and the clock correction
  runtime/
    module-def.ts         module code → SynthDef: param(), input(), fades, voices
    runtime.ts            patch document ⇄ engine: hot-swap, wiring, subpatches, abstractions, modsums, macros, monitors, undo, listen
    resolve.ts            lexical name resolution in the hierarchy (refs, params, macros, implicit outlets)
    graph.ts              one level as a graph (for the UI), Mermaid diagrams, node order, UGen netlists
    patch.ts, specs.ts    PatchDoc types; ControlSpec presets and warps
  engine/                 SuperSonic boot, groups, buses, meters, scopes, trace, clock calibration; analysis; system SynthDefs
    tap.ts                the tap on the engine's output and its ring (the capture buffer)
    samples.ts            the sample bank (fetch, decode, buffers, sharing, freeing; adopting recordings)
    sample-analysis.ts    waveform overview, onsets, tempo and beat counts, pitch
  seq/                    routines (generators on the session clock) and musical helpers
  agent/
    tool-defs.ts          the 22 tool schemas (shared with the Worker)
    tools.ts              their browser-side execution
    prompt.ts             the system prompt (+ UGen index)
  app/                    the store (sessions, autosave, branching, checkpoints, transport, focus) and the library client
    tree.ts               the library as a tree: context layers, branches at a message, families
    recorder.ts           ● REC on bar lines, ⟲ capture
    takes.ts              takes in IndexedDB, 24-bit WAV files
    mix.ts                which modules get a strip; the fader law
  ui/                     assistant-ui thread (action bars, branching, checkpoints) + push-to-talk, the library (Navigator),
                          session menu, dialogs, patcher graph, Performance/Selected/Mixer/Samples/Recordings panels, inspector, knobs
worker/
  index.ts                Access check, then /agents/* (routeAgentRequest) or /api/*
  agent.ts                PatterAgent: AIChatAgent → DeepSeek via AI Gateway, client tools; checkpoints; conversation export/import for branches
  library.ts, api.ts      PatchLibrary (AGENTS.md, sets, songs, sessions, the sample catalog) and its HTTP API (branching, checkpoints, samples in R2)
  access.ts               Access JWT verification
cloudflare.config.ts      Worker, Durable Object, bindings, route (cf CLI)
public/worklets/           patter-tap.js: the AudioWorklet that taps the engine's output
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
- sets, songs and sessions with AGENTS.md context at each level, branching
  from any message (edit, retry, branch from an answer or a checkpoint, ‹ n/m ›),
  checkpoints at every message and turn, and the stop/play transport
- the Mixer (faders, pan, mute, solo, meters), ● REC on bar lines, ⟲ capture
  of the last minutes, and takes kept in the browser
- samples: the stock pack and your own files in R2, analysis, OneShot,
  QLoop, Slice, Grains and bar-accurate recording
- the agent loop end to end, both locally and deployed to datspace.fm behind
  Access

Ideas next:

- slices at onsets (a per-sample slice table) and drum kits by note
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
- **Licensing.** SuperSonic is AGPL-3.0-or-later, so patter is too (see
  [LICENSE](../LICENSE)). If you serve a modified patter over a network, offer
  its users the source. The datspace.fm deployment stays private, behind
  Access, because the agent costs money, not because of the license.
