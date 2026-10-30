# patter

> Talk to your modular synth. It talks back. Sometimes it even listens.

You describe a patch the way you'd explain it to another modular nerd at 1 a.m.:

> *"Two slightly detuned saws into a Moog ladder. Slow LFO on the cutoff.
> Turing machine sequencer in minor pentatonic. Oh, and give me a 'darkness' macro."*

An agent builds it, **running**, in your browser, on real SuperCollider. Then
you keep talking while it plays. Swap the filter. Re-route the LFO. Make it
darker. Make it *less* darker. Undo.

No cables were harmed. A few were hallucinated, then debugged by the agent
that hallucinated them.

---

## Hi, I'm Jared

By day I'm an AI engineer at Mixpanel. By night I build music software instead
of making music.

My GitHub goes back to 2014 and documents exactly this habit: a 3D
sample-cube sampler in openFrameworks, norns scripts, a fork of a drum
machine's firmware, a generative MIDI controller for Ableton, a file-driven
algorithmic sequencer, and a Python composition framework whose README
describes it, with total honesty, as "pre-implementation".

patter is the newest layer. It's the one where I gave up wiring the patch myself and
hired a language model to wire it for me. It works better than it has any
right to, and I'm a bit smug about it. You'll see.

Number of finished tracks this has produced: classified.

---

## What it actually is

- **[SuperSonic](https://github.com/samaaron/supersonic)**: SuperCollider's
  `scsynth`, compiled to WebAssembly by Sam Aaron and running in an
  AudioWorklet. A real synthesis server in a browser tab.
- **A SynthDef compiler written in TypeScript.** You (or the agent) write
  JavaScript with sclang's signal semantics, and it compiles to the same
  bytes sclang would produce. We checked. See below. Obsessively.
- **An agent with 22 tools** (DeepSeek V4.1 Flash on Cloudflare Workers AI)
  whose whole job is translation, from how you describe a system to the
  things SuperCollider is made of: SynthDefs, nodes, buses, `/n_map`.
- **A patcher UI** with knobs, a mixer, a recorder, a sample library,
  subpatches, and a chat that branches like a choose-your-own-adventure book.
  There's push-to-talk too, so "describe it out loud" is literal.

What it is **not**: a "make me a dark techno banger" button. It assumes you
know what a VCA is. If you don't, it'll build you one anyway. You just won't be
impressed.

---

## Show me

A module is a few lines of code. This is what the agent writes, and you can
edit it too (⌘↩ hot-swaps it while it plays):

```js
// module "osc" (audio)
const freq = param('freq', 110, 'freq');
const detune = param('detune', 0.12, [0, 1]);
Saw.ar(freq * [1, 1 + detune * 0.01]) * 0.3
```

```js
// module "filter" (audio): reads osc's bus
MoogFF.ar(input('osc'), param('cutoff', 1200, 'freq'), param('res', 0.3, [0, 1]) * 3.5)
```

```js
modulate('lfo', 'filter.cutoff', 0.4)          // 40% of the knob's travel, in its own warp
modulate('macro:dark', 'filter.cutoff', -0.6)  // darkness, quantified
```

And sequencing is a JavaScript generator, where `yield` means "wait this many beats":

```js
// routine "melody": a Turing-machine line, because of course
const reg = turing(8, 0.15);
const accents = euclid(5, 16);
let i = 0;
while (true) {
  play('pluck', { note: degree(Math.floor(reg.next() * 10), 'minorPentatonic', 48),
                  dur: 0.25, amp: accents[i++ % 16] ? 0.25 : 0.12 });
  yield 0.25;
}
```

Everything is real SuperCollider underneath: real UGens, real argument
orders, multichannel expansion, `Env`s, `doneAction: 2`. It's JavaScript on top
because JavaScript is what browsers run and what models write without
complaining.

---

## Things I'm smug about, ranked

1. **The compiler is golden-tested against sclang itself.** Each of 33 graphs
   is written twice, once in sclang and once in patter, compiled by both, and
   compared as Merkle DAGs with commutativity normalised. They all pass. This
   is either rigor or a cry for help.
2. **All 377 UGens, catalogued by interrogating sclang 3.14.1.** Every
   constructor was probed with sentinel values until it gave up where each
   argument lands. sclang's quirks (Stepper's `resetval` defaults to `min`,
   `Dstutter` is secretly `Ddup`) are written down so the agent doesn't trip on
   them.
3. **Hot-swap without clicks.** Redefine a module mid-drone and the new synth
   starts beside the old one and crossfades, JITLib-style. Your knob values
   carry over.
4. **The agent can listen.** It records a module's bus and gets peak, RMS, DC
   offset, spectral centroid, pitch, partials and a 50 ms envelope. In testing,
   from a one-sentence description, it built a patch, listened, rebalanced
   the gain, listened *again*, labelled five knobs and handed over a patch
   sheet, all in about 36 seconds. That's more checking than most of us do
   before uploading to SoundCloud.
5. **Subpatches and abstractions, Pd/Max-style.** Lexical scoping, inlets and
   outlets, ⌘G to group. Edit one instance of an abstraction and every other
   instance follows, in place, still playing.
6. **QLoop**, a looper where every knob is quantized in both value and time,
   and the playhead is a pure function of the transport. Any combination of
   settings is a seamless loop, so you can modulate it freely and it
   can't fall off the grid.
7. **Branching conversations.** Every message is a checkpoint. Edit an old
   message and you get a new branch with the patch as it was back then.
   ‹ n/m › flips between timelines, sound and all. A multiverse of bad ideas,
   none of them lost.
8. **AGENTS.md per song.** Say "this song is in D minor at 92" once and it
   remembers. In testing it followed that unprompted, which is better than I
   manage.
9. **● REC on bar lines** gives you whole-bar takes that loop. **⟲ Capture**
   saves the last few minutes, because it was listening all along (the good
   kind of always-listening).
10. **A mixer the agent is told to keep its hands off.** Your faders are your
    faders.

There's much more (samples with onset and pitch analysis, a sample-accurate
session clock, `/n_trace`, Mermaid diagrams of your patch), and it's all in
**[the manual](docs/MANUAL.md)**, which is the serious version of this
document. It has tables.

---

## How it fits together

```
 your browser                                         Cloudflare
┌────────────────────────────────────┐   WebSocket   ┌────────────────────────────────┐
│ chat UI ──────────────────────────────────────────▶│ PatterAgent (Durable Object)   │
│   ▲                                │               │   conversation in SQLite       │
│   │ tool calls run HERE, on the    │◀──────────────│   DeepSeek via AI Gateway      │
│   │ live engine, not on a server   │  "define_     │                                │
│   ▼                                │   module…"    │ PatchLibrary (Durable Object)  │
│ runtime ⇄ patch document           │               │   sessions, songs, AGENTS.md   │
│ compiler: JS → UGens → SynthDef    │               │ R2: your samples               │
│ SuperSonic: scsynth.wasm  ♪        │               └────────────────────────────────┘
└────────────────────────────────────┘
```

The model thinks in the cloud and the sound happens in your tab. Every tool is
a client tool: the model asks for something, the browser does it to the
running engine, and the answer goes back. The patch document (JSON) is the
source of truth, so saving, undo and branching all work on the document.

Going on air is the same idea pointed outwards. My browser sends the patch
document, the conversation and the transport to one more Durable Object, and
it passes them to everyone listening:

```
 my browser, signed in           Cloudflare                      your browser
┌──────────────────────┐        ┌───────────────────────┐        ┌──────────────────────┐
│ patch, conversation, │  PUT   │ OnAir (Durable Object)│ /listen│ the same patch, on   │
│ ⌘. and ▶             │───────▶│   what's on air       │───────▶│ your own scsynth     │
│                      │ /api/  │   listeners' sockets  │  Web-  │ the conversation,    │
│                      │ on-air │   (hibernating)       │ Socket │ to read              │
└──────────────────────┘        └───────────────────────┘        └──────────────────────┘
```

---

## Listening

One session at a time can be **on air**. When I flip the switch, everyone at
datspace.studio gets the patch I'm working on, built in their own tab on their
own copy of scsynth (nothing is streamed as audio), and the conversation that's
building it, after each turn. When I turn a knob, theirs turns a moment
later. When the agent
redefines a module, it crossfades in on their end too, and the rest keeps
playing. When I hit ⌘., their sound stops.

Every knob, macro, fader and mute is theirs to play with. **Follow** (on by
default) means my next change puts my version back. Untick it and their patch
stays theirs while my changes queue up behind a "rejoin" button. What they
can't do is prompt, save, upload, rename, branch, or change the patch's
structure. Those controls aren't greyed out on their page. They aren't there
at all. Where the chat box would be, one line says who's driving.

The conversation shows my messages, the agent's replies and its tool calls.
Tool calls that read my library (AGENTS.md, the list of my samples) show up
without their results.

Off air, the last patch stays up (with "off air since 9:41 PM"), so whoever
comes by later still gets something to play with.

### Who can reach what

The host's paths (`/api`, `/agents`, `/login`) sit behind a Cloudflare Access
application, and the Worker checks the Access JWT again before it does
anything on them. Everything else is public:

| A listener's page asks for | What it gets |
| --- | --- |
| `/`, the app, Sonic Pi's samples | static files (no Worker runs) |
| `GET /whoami` | `{ "host": false }` |
| `GET /listen` | a WebSocket: what's on air, then each change |
| `GET /listen/state` | the same, once, as JSON |
| `GET /listen/samples/:sha256` | a sample from my library, but only while the patch on air plays it |

A listener's page never asks for `/api` or `/agents`. If something else asks,
Access turns it away at the edge before the Worker even runs. That rules out
the model, the library, R2 writes and going on air. The WebSocket only opens
for the page itself, the room holds 2,000 listeners (32 to an address), and
anything a listener sends down it, apart from a keep-alive ping, closes it.
`/whoami` and `/listen` are rate limited per IP.

### Why listeners don't cost me anything

The agent spends real money per token, and it's the only part of patter that
does. Listeners can't get anywhere near it. What a listener does use is a
handful of Worker and Durable Object requests, one R2 read per sample (their
browser keeps it after that), and a WebSocket that sits in a hibernating
Durable Object, which bills nothing while it waits. Messages out to listeners
are free. All of that fits in the Workers plan's included usage, and the rate
limit means nobody can run it up for me. An audience is cheaper than a prompt.

---

## Run it yourself

```bash
npm install     # also copies SuperSonic's wasm/workers/synthdefs into public/
npm run dev     # http://localhost:5317 (add ?listen to see a listener's page)
npm test        # 151 unit + golden tests, ~half a second
```

The fine print, of which there's some:

- **You'll need a Cloudflare account.** The agent runs on Workers AI, a
  remote binding even in local dev, so `cf auth login` first. Then change
  `accountId` in `cloudflare.config.ts` to yours, unless you'd like your tokens
  billed to me. (Please don't.)
- **An AI Gateway** named `patter`, or point `AI_GATEWAY` at one you have.
- **Access checks are off in dev**, so in dev everyone is the host; `?listen`
  gets you a listener's page. To deploy, swap in your own route, zone, Access
  team, audience tag and allowed emails in `cloudflare.config.ts`, then run
  `npm run deploy`.
- **Access covers only the host's paths.** Point a self-hosted Access
  application at `/api`, `/agents` and `/login` on your hostname. Leave the
  rest public, and leave its Cookie Path Attribute off, or the sign-in cookie
  never reaches `/whoami`. To sign in as the host, open `/login`.
- **It needs a cross-origin isolated page.** SuperSonic's transport uses
  SharedArrayBuffer, and the COOP/COEP headers are already set for dev and
  prod. The smoke tests (`scripts/smoke-*.mjs`) drive headless Chromium.

---

## Can I play with yours?

It's live at **[datspace.fm](https://datspace.fm)**, and no, you can't get in.
Nothing personal. The agent spends real money per token, so the site is behind
Cloudflare Access with an allowlist of exactly one email address. The bouncer
is a JWT, and it doesn't care who you know.

Clone it and run your own. That's what the license is for.

---

## FAQ (frequently anticipated questions)

**Why "patter"?**
Patch + chatter. Also it's what I do when someone at a party asks what
modular synthesis is, and I keep going until they leave.

**Why JavaScript instead of sclang?**
Browsers run it and models write it fluently. An AST rewrite gives it sclang's
operator overloading on signals. One difference: sclang evaluates
`a + b * c` strictly left to right, as a matter of personality. patter uses
normal precedence. Everything else (UGen names, argument orders, rates,
multichannel rules) is sclang's.

**Will this replace learning SuperCollider?**
No, it'll speed it up. The agent writes real SuperCollider, so you end up
reading a lot of it. You'll learn faster still the first time it gets `Klank`'s
arguments wrong and you have to fix them yourself.

**Does it work offline?**
The sound does. The talking doesn't.

**Can it make a whole song?**
It can build the instrument, sequence it, record bar-perfect takes and keep
your song's key in its notes. Finishing the song is on you, which, as
mentioned, is historically where things go wrong.

**What's next?**
Slicing at onsets, fusing a subpatch into a single polyphonic SynthDef, MIDI
in and out, Strudel/Tidal mini-notation, and an MCP bridge so Claude Code can
drive the same tools. All of it scheduled, as is tradition, for right after I
finish a track.

---

## License

**[AGPL-3.0-or-later](LICENSE).** patter runs on SuperSonic, which is AGPL, so
patter is too. If you run a modified patter as a network service, offer your
users the source. That's the deal, and it's a good one. Mine does: every
listener's page links to this repo and to SuperSonic's.

The bundled Sonic Pi sample pack is CC0, and SuperSonic's synthdefs are MIT.

## Thanks

- **[SuperCollider](https://supercollider.github.io)**, James McCartney, and
  twenty-odd years of contributors, for the best synthesis engine I've ever
  used.
- **[Sam Aaron](https://github.com/samaaron)** for SuperSonic, which got
  scsynth running in a browser tab and made this whole project possible.
- **Sonic Pi** for 206 CC0 samples.
- [assistant-ui](https://github.com/assistant-ui/assistant-ui),
  [Cloudflare Agents](https://github.com/cloudflare/agents) and
  [acorn](https://github.com/acornjs/acorn).

---

<p align="center"><sub>Made in South Lake Tahoe by <a href="https://github.com/discohead">@discohead</a>, who should probably go outside.</sub></p>
