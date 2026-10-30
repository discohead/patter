// The conversation in brief: what a tool call was about (for the chat's tool
// cards), and the conversation as listeners get it while it's on air.

import type { UIMessage } from 'ai';
import type { TranscriptMessage, TranscriptPart } from './on-air';

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

type ToolPart = { type: string; toolName?: string; toolCallId: string; input?: unknown; output?: unknown; state?: string; errorText?: string };
const isTool = (p: { type: string }) => p.type.startsWith('tool-') || p.type === 'dynamic-tool';

/** A turn is over: every tool call has its answer, or will never get one (its turn was stopped). */
export function settled(messages: UIMessage[], abandoned: Set<string>): boolean {
  const last = messages[messages.length - 1];
  if (last?.role !== 'assistant') return true;
  return !last.parts.some((p) => {
    if (!isTool(p)) return false;
    const t = p as ToolPart;
    return t.state !== 'output-available' && t.state !== 'output-error' && !abandoned.has(t.toolCallId);
  });
}

/**
 * The conversation as listeners get it: the host's messages, the agent's
 * replies, and each tool call by name and subject, how it went and the start
 * of what it returned. Reasoning stays out.
 */
export function compactTranscript(messages: UIMessage[]): TranscriptMessage[] {
  return messages.flatMap((m): TranscriptMessage[] => {
    if (m.role !== 'user' && m.role !== 'assistant') return [];
    const parts: TranscriptPart[] = [];
    if (m.role === 'user') {
      const text = textOf(m);
      if (text) parts.push({ type: 'text', text });
    }
    for (const p of m.role === 'assistant' ? m.parts : []) {
      if (p.type === 'text') {
        if (p.text.trim()) parts.push({ type: 'text', text: p.text });
      } else if (isTool(p)) {
        const t = p as ToolPart;
        const name = p.type === 'dynamic-tool' ? t.toolName ?? 'tool' : p.type.slice(5);
        const out = t.state === 'output-error' ? `ERROR: ${t.errorText ?? ''}` : typeof t.output === 'string' ? t.output : t.output === undefined ? '' : JSON.stringify(t.output);
        const done = t.state === 'output-available' || t.state === 'output-error';
        parts.push({
          type: 'tool',
          name,
          subject: subjectOf(name, t.input as Record<string, unknown> | undefined),
          state: !done ? 'stopped' : out.startsWith('ERROR:') ? 'error' : 'ok',
          ...(out ? { result: out.slice(0, 240) } : {}),
        });
      }
    }
    return parts.length ? [{ id: m.id, role: m.role, parts }] : [];
  });
}
