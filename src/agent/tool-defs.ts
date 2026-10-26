// Tool definitions — the agent's whole surface. The Worker hands these to
// the model; the browser executes them (tools.ts), since they act on the
// running engine in the page.

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const S = {
  str: (description: string) => ({ type: 'string', description }),
  num: (description: string) => ({ type: 'number', description }),
  bool: (description: string) => ({ type: 'boolean', description }),
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'define_module',
    description:
      'Create a module, or replace an existing one\'s code (hot-swap with a crossfade on the same bus; knob values carry over). ' +
      'The code is patch-language JavaScript whose last expression (or return) is the output signal. ' +
      'Returns the module\'s params (with ranges), output shape, inputs, warnings — or the compile/engine error to fix.',
    input_schema: {
      type: 'object',
      properties: {
        name: S.str('lowercase identifier, e.g. "osc", "filter", "lfo_slow" — or a path, "voice/env", to put it inside subpatch "voice" (created if missing)'),
        kind: { type: 'string', enum: ['audio', 'control', 'voice'], description: 'audio: persistent audio synth; control: persistent control-rate synth (LFOs, envelopes, clocks, sequencers — modulation sources); voice: one synth per note, played by routines' },
        code: S.str('patch-language source'),
        params: { type: 'object', description: 'initial knob values by param name (optional)', additionalProperties: { type: 'number' } },
        play: S.bool('audio/voice modules: send to the master mix (default true for audio/voice, false for control). Set false for modules that only feed other modules.'),
        level: S.num('monitor level when played (default 1)'),
        fade_time: S.num('crossfade seconds when this module is later replaced (default 0.5 audio, 0.2 control)'),
        description: S.str('one line: what this module is in the user\'s terms'),
      },
      required: ['name', 'kind', 'code'],
    },
  },
  {
    name: 'remove_module',
    description: 'Fade out and remove a module (and its modulation routes). Fails if other modules read it with input(), unless force. (To remove a whole subpatch use subpatch "remove".)',
    input_schema: {
      type: 'object',
      properties: { name: S.str('module path'), force: S.bool('remove even if other modules read it') },
      required: ['name'],
    },
  },
  {
    name: 'subpatch',
    description:
      'Structure the patch into subpatches, as in Pd/Max. A subpatch is a scope with an interface (inlets, outlets, controls), so from outside it behaves like one module: input("voice") reads its main outlet, "voice.cutoff" is one of its controls. ' +
      'Modules live in it by path ("voice/filter"). Inside, input() names resolve to siblings first, then to the subpatch\'s inlets; "../x" reads the parent scope, "/x" the top level, "voice/env" reaches in. ' +
      'Without declared outlets, a subpatch\'s output is the one module inside that nothing else inside reads. ' +
      'Actions — "group": move existing modules/subpatches (members, named in the scope that contains path) into a new subpatch at path; it gets an inlet for each outside thing they read (named like the source, so their code doesn\'t change) and an outlet for what outside reads; outside readers are rewritten to read the outlet. Nothing restarts. ' +
      '"ungroup": dissolve a subpatch into its parent (the reverse). "configure": create a subpatch or change its interface and description (null removes an entry). "remove": delete it and everything inside. "duplicate": copy it to `to` (default: the next free name); a copy of an abstraction instance is another instance. ' +
      'Inside an abstraction instance, all of these happen in every instance.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['group', 'ungroup', 'configure', 'remove', 'duplicate'] },
        path: S.str('the subpatch, e.g. "voice" or "drums/kick"'),
        members: { type: 'array', items: { type: 'string' }, description: 'group: names of the modules/subpatches to move in, as named in the parent scope ("osc", "filter")' },
        description: S.str('what the subpatch is, in the user\'s terms'),
        inlets: {
          type: 'object',
          description: 'configure: inlet name → { from: a ref in the parent scope, or null for unconnected; rate?: "audio"|"control"; channels? } — or null to remove the inlet. Changing from re-patches without restarting anything.',
          additionalProperties: true,
        },
        outlets: { type: 'object', description: 'configure: outlet name → inner ref ("vca", "env.gate"), or null to remove. The first outlet is the main output.', additionalProperties: true },
        controls: {
          type: 'object',
          description: 'configure: control name → inner param ref ("filter.cutoff") or inner macro ("macro:bright"), or null to remove. Controls are the subpatch\'s face: its own Performance Panel, and what "voice.<control>" means from outside.',
          additionalProperties: true,
        },
        to: S.str('duplicate: the new path'),
        force: S.bool('remove: even if modules outside read it'),
      },
      required: ['action', 'path'],
    },
  },
  {
    name: 'abstraction',
    description:
      'Reusable subpatches. "save" makes a subpatch a named abstraction; the subpatch becomes its first instance. "instantiate" builds a new instance at path, with its own inlet connections and knob values. ' +
      'All instances share one definition: redefining a module, a route, a macro or the interface inside ANY instance changes the abstraction and every other instance; knob values stay per instance. ' +
      '"detach" cuts an instance loose, so later edits stay local. "list" shows each abstraction, its interface and its instances.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'instantiate', 'detach', 'list'] },
        name: S.str('abstraction name (save, instantiate)'),
        path: S.str('save/detach: the subpatch; instantiate: where the new instance goes, e.g. "voice2"'),
        inlets: { type: 'object', description: 'instantiate: inlet name → source ref in the parent scope (or null)', additionalProperties: true },
        params: { type: 'object', description: 'instantiate: initial knob values, "osc.freq" (an inner param) or "cutoff" (a control) → value', additionalProperties: { type: 'number' } },
        description: S.str('save: what it is'),
      },
      required: ['action'],
    },
  },
  {
    name: 'set_params',
    description: 'Turn knobs: module params ("filter.cutoff", "voice/filter.cutoff"), subpatch controls ("voice.cutoff") or macros ("macro:dark", 0..1). Values are in the param\'s own units.',
    input_schema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: { target: S.str('"module.param", "subpatch.control" or "macro:name"'), value: S.num('new value') },
            required: ['target', 'value'],
          },
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'modulate',
    description:
      'Patch modulation routes (CV with an attenuverter). source: a control module ("lfo", "voice/env"), a named output ("seq.gate") or channel ("env.0"), a subpatch outlet ("voice", "voice.env"), or a macro ("macro:dark"). ' +
      'target: a control-rate param ("filter.cutoff", "voice/filter.cutoff") or subpatch control ("voice.cutoff"). A route between two things inside an abstraction instance is part of the abstraction (every instance gets it). amount is in knob-range units within the param\'s warp: 1 sweeps the whole range, -0.3 pulls down 30%. amount 0 removes the route. ' +
      'Sources should be normalised (LFOs ±1, envelopes/gates 0..1).',
    input_schema: {
      type: 'object',
      properties: {
        routes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { source: S.str('modulation source'), target: S.str('"module.param"'), amount: S.num('-1..1 typically; 0 removes') },
            required: ['source', 'target', 'amount'],
          },
        },
      },
      required: ['routes'],
    },
  },
  {
    name: 'define_macro',
    description:
      'Create or redefine a macro knob (0..1) routed to several params with per-target amounts (same units as modulate). ' +
      'Given targets replace the macro\'s previous routes. Use for perceptual controls: "dark", "density", "tension", "space".',
    input_schema: {
      type: 'object',
      properties: {
        name: S.str('lowercase identifier, or a path to keep it inside a subpatch ("voice/bright"; route to it from outside as "macro:voice/bright")'),
        label: S.str('knob label, e.g. "Darkness"'),
        value: S.num('initial position 0..1 (default 0)'),
        bipolar: S.bool('if true, 0.5 is neutral and the macro pushes both ways'),
        description: S.str('what it does, in the user\'s terms'),
        targets: {
          type: 'array',
          items: { type: 'object', properties: { target: S.str('"module.param"'), amount: S.num('route amount') }, required: ['target', 'amount'] },
        },
      },
      required: ['name', 'targets'],
    },
  },
  {
    name: 'remove_macro',
    description: 'Remove a macro and its routes.',
    input_schema: { type: 'object', properties: { name: S.str('macro name') }, required: ['name'] },
  },
  {
    name: 'define_routine',
    description:
      'Create or replace a routine: the body of a JS generator; `yield n` waits n beats. It plays voices, sets module controls and moves knobs in time. ' +
      'Replacing a playing routine swaps it on its next quant boundary. Syntax errors return immediately; runtime errors stop the routine and are reported later.',
    input_schema: {
      type: 'object',
      properties: {
        name: S.str('lowercase identifier'),
        code: S.str('generator body'),
        quant: S.num('start/swap on a multiple of this many beats (default 4; 0 = immediately)'),
        play: S.bool('start playing (default true)'),
        description: S.str('what it does'),
      },
      required: ['name', 'code'],
    },
  },
  {
    name: 'routine_control',
    description: 'Play, stop or remove a routine; or stop all routines (name "*").',
    input_schema: {
      type: 'object',
      properties: { name: S.str('routine name or "*"'), action: { type: 'string', enum: ['play', 'stop', 'remove'] } },
      required: ['name', 'action'],
    },
  },
  {
    name: 'set_tempo',
    description: 'Set the session tempo (BPM). Routines and LinkPhase/LinkTempo UGens follow it.',
    input_schema: { type: 'object', properties: { bpm: S.num('beats per minute') }, required: ['bpm'] },
  },
  {
    name: 'mix',
    description: 'Mixer settings for a module\'s send to the master: play (on/off), level, pan (-1..1), mute. A subpatch means the module behind its main outlet. Or the master level (module "master").',
    input_schema: {
      type: 'object',
      properties: {
        module: S.str('module path, subpatch, or "master"'),
        play: S.bool('send to master'),
        level: S.num('linear gain'),
        pan: S.num('-1..1'),
        mute: S.bool('mute'),
      },
      required: ['module'],
    },
  },
  {
    name: 'expose_controls',
    description:
      'Choose the knobs on the user\'s Performance Panel (the top level\'s), in order, with labels and groups. Refs: "module.param", "subpatch.control" or "macro:name". ' +
      'Expose what the user asked for and the handful of controls that matter musically — not every param. A subpatch\'s own panel is its controls (subpatch "configure").',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { ref: S.str('"module.param", "subpatch.control" or "macro:name"'), label: S.str('short label'), group: S.str('section heading, e.g. "Filter"') },
            required: ['ref'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'listen',
    description:
      'Record a module\'s output bus (or "master") for a moment and describe it: peak/RMS dB, DC, clipping, spectral centroid/rolloff/flatness, strongest partials, pitch estimate, a 50 ms RMS envelope and pulse rate; ' +
      'for control modules: min/max/mean/rate per channel. Use it to check your work and to debug silence, noise, clipping or wrong pitch.',
    input_schema: {
      type: 'object',
      properties: { module: S.str('module path, subpatch (its main outlet), "voice.env" (a named outlet) or "master"'), seconds: S.num('0.25..4, default 1') },
      required: ['module'],
    },
  },
  {
    name: 'inspect',
    description: 'Look at the running system: "patch" (everything, compact), "module" (one module: code, params, routes), "subpatch" (its interface, what its inlets resolve to, what\'s inside), "routines", "log" (recent engine messages), "tree" (scsynth node tree).',
    input_schema: {
      type: 'object',
      properties: { what: { type: 'string', enum: ['patch', 'module', 'subpatch', 'routines', 'log', 'tree'] }, name: S.str('module or subpatch path') },
      required: ['what'],
    },
  },
  {
    name: 'graph',
    description:
      'See the structure. With no module: the patch as a Mermaid flowchart (modules, subpatches as nested subgraphs, input() cables: solid audio / dashed control, modulation routes with amounts, macros, sends to master) plus the engine\'s execution order. ' +
      'path focuses on one subpatch; depth folds subpatches deeper than that into single boxes. ' +
      'With a module: its compiled UGen netlist (one line per UGen, inputs by argument name) — exactly what the code became, including rate conversions and folded constants.',
    input_schema: {
      type: 'object',
      properties: {
        module: S.str('optional module path for its UGen netlist'),
        path: S.str('optional subpatch to draw instead of the whole patch'),
        depth: S.num('optional: how many subpatch levels to open (default all)'),
      },
    },
  },
  {
    name: 'trace',
    description: 'Snapshot live values inside a running module (scsynth /n_trace): every UGen\'s input and output values for one block. Use when a module misbehaves and listen() is not enough.',
    input_schema: { type: 'object', properties: { module: S.str('module path or subpatch (persistent kinds; for voices, trace needs a sounding note)') }, required: ['module'] },
  },
  {
    name: 'ugen_reference',
    description: 'Look up UGens: constructors, argument names/defaults (in input order), outputs, and help text. Use before using an unfamiliar UGen.',
    input_schema: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' }, description: 'UGen class names, e.g. ["Formlet", "GrainSin"]' } },
      required: ['names'],
    },
  },
  {
    name: 'clear_patch',
    description: 'Remove every module, macro and routine (fading out). Only when the user wants to start over.',
    input_schema: { type: 'object', properties: { confirm: S.bool('must be true') }, required: ['confirm'] },
  },
  {
    name: 'annotate',
    description: 'Set the patch title and/or notes (a short description of the system, shown to the user).',
    input_schema: { type: 'object', properties: { title: S.str('patch title'), notes: S.str('notes') } },
  },
];

