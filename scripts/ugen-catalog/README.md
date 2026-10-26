# UGen catalog (sclang 3.14.1)

`ugen-catalog.json` describes how sclang 3.14.1 turns each UGen constructor call into SynthDef units:
the positional args and defaults, mul/add handling, rate, the exact input order, the output count, and
the sclang-side transformations. It covers the 377 sclang classes whose server name is in
`../engine_ugens.txt`, so it is meant for a compiler that has to produce the same bytes as sclang.
Field semantics are documented inside the file (`_meta.inputKinds`, `_meta.methodFields`, `_meta.ugenFields`).

All of it comes from running sclang. Nothing was taken from `packages/defsynth/.../metadata.json`
except doc text, and that only as a fallback after the `.schelp` files.

## Regenerate

```sh
./regenerate.sh      # about 50 s; never boots a server
```

Every sclang run uses `HOME=../schome`, which keeps the user's `startup.scd` (which boots SuperDirt)
from running. The script runs these steps:

| step | file | output |
|---|---|---|
| probe every ar/kr/ir/new constructor with sentinels (scalar, array, nil and DC-wrapped args) in an unfinished SynthDef build | `probe.scd` | `probe_raw.jsonl` |
| hand-written probes with valid args for the transforming constructors | `probe_special.scd` | `special_raw.jsonl` (evidence only) |
| operator selector → specialIndex | `ops.scd` | `ops_raw.json` |
| decode probes, add docs, special texts | `build-catalog.mjs`, `docs.mjs` | `ugen-catalog.json`, `build-report.txt` |
| compile 1584 SynthDefs with sclang and compare the parsed SCgf bytes with the catalog's predictions | `verify.mjs gen/check` | `verify_report.txt` |

Current result: 592 of 592 methods and special cases match sclang's bytes. That covers inputs and
constants, rate, output count, specialIndex, MulAdd placement, post-ops, PV_Copy insertion and the
MaxLocalBufs count. `ext-classes/` contains copies of the sc3-plugins classes (DistortionUGens, MdaPiano)
and the repo's `test/synthdefs/sc-classes/LinkUGen.sc`. `show_special.mjs` and `sources.mjs` are viewers
used during review.

## `special` (30 entries)

- **Encoded with their own input kinds:** EnvGen and IEnvGen (Env flattening, shape numbers), Klank and Klang (spec Ref layout and multichannel Refs), Dwrand, Dpoll, Poll, SendReply and SendPeakRMS (strings become a length plus ascii codes), InRect (Rect fields), LocalIn (defaults wrap-extended), LocalBuf and MaxLocalBufs (the auto-created count unit).
- **Constructor behaviour:** VarLag (an EnvGen graph unless warp is linear), Lag family (bypass when `in` is scalar), Dstutter (emits `Ddup`), Out family (0 channels become one shared `DC.ar(0)`), asAudioRateInput (DelayN/CombN/... `.ar` wrap `in` in DC.ar or K2A.ar), DemandEnvGen (K2A on gate/reset), WhiteNoise family (array `mul`), LinXFade2 (level is a post `*`), DecodeB2 (orientation is ignored).
- **Graph-level rules:** PV_ChainUGen (PV_Copy insertion at finish), WidthFirstUGen (topological-sort antecedents), and the internal units BinaryOpUGen, UnaryOpUGen, MulAdd, Sum3, Sum4 and Control (degenerate-case folding, optimisation, rate rules, input sorting).

`failed` lists the 7 engine units that have no sclang class: Flip, GrainTap, SimpleLoopBuf, UnitCmdDemo,
Unwrap, SPLimiter and SPLimiter2. The SPLimiter entries include the signature given in their C++ header,
which was not verified against sclang.

## Unsure / caveats

- `sideEffect` is a judgement call, because sclang 3.14.1 has no `hasObservableEffect`. It is true for UGens that write buses or buffers, send messages, free or pause nodes (including through doneAction), or change synth state, and for the PV_* units that write into the chain buffer. For byte compatibility, use `pure` instead. It holds sclang's actual dead-code rule.
- The `checks` strings paraphrase each `checkInputs` override in the class library. Verification confirmed that every method whose plain-number call fails has a `checks` entry; the reverse direction was not tested.
- The docs are the first one or two sentences of each schelp entry. Pitch, ScopeOut2, ClearBuf, SetBuf, BlockSize, NodeID, AudioControl, LinkPhase and LinkTempo docs were written by hand. LinkTempo's `gate` and `tempo` are ignored by SuperSonic's C++.
- In 3.14, a default can be an expression that sclang evaluates. A constant result is shown as the default (`AmpComp` 60.midicps = 261.6255653005986). A default that refers to another argument becomes `nilMeans` (`Delay1.kr`/`Delay2.kr` x1 = `in`).
- `MaxLocalBufs.inputs` shows `{const: 0}`, but the real input is the number of LocalBufs in the def (see special.LocalBuf).
- `OffsetOut.kr` is left out on purpose: sclang's version is `shouldNotImplement`.
- Pseudo-UGens are not catalogued: Mix, Splay, LinLin, Silent, SoundIn, DynKlank, Changed, PMOsc and others. They expand into catalogued units. For example, Mix becomes Sum4/Sum3 over `clump(4)`, and Silent becomes `DC.ar(0)`.
- The catalog does not cover the SynthDef-level ordering of constants, controls and topological sort, beyond the WidthFirst and PV_Copy notes.
- sclang quirk hit during probing: when an exception is caught while `Exception.inProtectedFunction` is set (backtrace capture), enclosing functions sometimes returned the wrong value. Every `try` body in these scripts clears that flag first.
