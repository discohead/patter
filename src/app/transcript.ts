// The conversation in brief: what a tool call was about, for the chat's tool
// cards and for the conversation listeners read.

import type { UIMessage } from 'ai';

export const TOOL_LABEL: Record<string, string> = {
  define_module: 'module', remove_module: 'remove', set_params: 'knobs', modulate: 'patch',
  define_macro: 'macro', remove_macro: 'remove macro', define_routine: 'routine', routine_control: 'routine',
  set_tempo: 'tempo', mix: 'mix', expose_controls: 'surface', listen: 'listen', inspect: 'inspect',
  graph: 'graph', trace: 'trace', ugen_reference: 'reference', clear_patch: 'clear', annotate: 'notes',
  subpatch: 'subpatch', abstraction: 'abstraction', samples: 'samples', context: 'AGENTS.md',
};

export function subjectOf(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  if (name === 'samples') return `${args.action ?? ''} ${args.name ?? args.query ?? args.where ?? ''}${args.from ? ` ← ${args.from}` : ''}`.trim();
  if (name === 'context') return `${args.action ?? ''} ${args.action === 'read' ? '' : args.level ?? 'song'}`.trim();
  if (name === 'subpatch' || name === 'abstraction') {
    const members = Array.isArray(args.members) ? ` (${(args.members as string[]).join(', ')})` : '';
    const what = name === 'abstraction' && args.action === 'instantiate' ? `${args.name} → ${args.path}` : name === 'abstraction' && args.action === 'save' ? `${args.path} as ${args.name}` : args.path ?? args.name ?? '';
    return `${args.action ?? ''} ${what}${members}`.trim();
  }
  if (typeof args.name === 'string') return args.name;
  if (typeof args.module === 'string') return args.module;
  if (Array.isArray(args.routes)) return (args.routes as { source: string; target: string }[]).map((r) => `${r.source}→${r.target}`).join(', ');
  if (Array.isArray(args.updates)) return (args.updates as { target: string; value: number }[]).map((u) => `${u.target}=${u.value}`).join(', ');
  if (typeof args.bpm === 'number') return `${args.bpm} bpm`;
  if (Array.isArray(args.names)) return (args.names as string[]).join(', ');
  if (name === 'graph') return 'patch';
  return '';
}

/** A message's text, without the patch state that rides along with the person's messages. */
export const textOf = (m: UIMessage | undefined) =>
  (m?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('').replace(/<patch_state>[\s\S]*<\/patch_state>/g, '').trim();
