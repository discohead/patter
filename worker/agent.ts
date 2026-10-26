// The patter agent: a Durable Object that holds the conversation (SQLite,
// via AIChatAgent) and talks to DeepSeek V4.1 Flash on Workers AI through AI
// Gateway. Every tool is a client tool: the model calls it here, the browser
// runs it against the live SuperSonic engine, and AIChatAgent continues the
// turn when the results come back.

import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import { createAI } from 'agents/models/ai-sdk';
import { convertToModelMessages, jsonSchema, streamText, tool, type ToolSet, type UIMessage } from 'ai';
import { systemPrompt } from '../src/agent/prompt';
import { TOOL_DEFS } from '../src/agent/tool-defs';

export const MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const SYSTEM = systemPrompt();
const MAX_TOOL_CALLS_PER_TURN = 150;

// No `execute`: the model asks, the browser answers.
const TOOLS: ToolSet = Object.fromEntries(
  TOOL_DEFS.map((d) => [d.name, tool({ description: d.description, inputSchema: jsonSchema(d.input_schema as never) })]),
);

interface Body {
  /** A compact JSON snapshot of the running patch when the user sent the message. */
  patchState?: string;
  settings?: { effort?: 'off' | 'low' | 'high' };
}

export class PatterAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish: Parameters<AIChatAgent<Env>['onChatMessage']>[0], options?: OnChatMessageOptions): Promise<Response> {
    this.sql`CREATE TABLE IF NOT EXISTS patch_states (message_id TEXT PRIMARY KEY, state TEXT NOT NULL)`;
    const body = (options?.body ?? {}) as Body;
    const messages = this.messages;

    // Remember what the patch looked like when each user message was sent, and
    // replay it with that message every time — a stable prefix for the cache.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!options?.continuation && lastUser && typeof body.patchState === 'string') {
      this.sql`INSERT OR REPLACE INTO patch_states (message_id, state) VALUES (${lastUser.id}, ${body.patchState.slice(0, 40_000)})`;
    }
    const rows = this.sql<{ message_id: string; state: string }>`SELECT message_id, state FROM patch_states`;
    const states = new Map(rows.map((r) => [r.message_id, r.state]));
    const withState: UIMessage[] = messages.map((m) => {
      const st = m.role === 'user' ? states.get(m.id) : undefined;
      return st ? { ...m, parts: [...m.parts, { type: 'text' as const, text: `<patch_state>${st}</patch_state>` }] } : m;
    });

    const last = messages[messages.length - 1];
    const calls = last?.role === 'assistant' ? last.parts.filter((p) => p.type.startsWith('tool-') || p.type === 'dynamic-tool').length : 0;
    if (calls > MAX_TOOL_CALLS_PER_TURN) {
      return new Response(`Stopping here: this turn made more than ${MAX_TOOL_CALLS_PER_TURN} tool calls. Tell me how to continue.`, {
        headers: { 'content-type': 'text/plain' },
      });
    }

    const effort = body.settings?.effort ?? 'low';
    const ai = createAI({ binding: this.env.AI, gateway: { id: this.env.AI_GATEWAY } });
    const result = streamText({
      model: ai(MODEL, {
        reasoningEffort: effort === 'off' ? null : effort,
        // Same instance → same backend → prefix-cache hits on the long prompt.
        sessionAffinity: this.name,
      }),
      system: SYSTEM,
      messages: await convertToModelMessages(withState, { tools: TOOLS, ignoreIncompleteToolCalls: true }),
      tools: TOOLS,
      maxOutputTokens: 32_000,
      abortSignal: options?.abortSignal,
      onFinish: onFinish as never,
    });
    return result.toUIMessageStreamResponse({
      // Say what went wrong (the default masks every error as "An error occurred").
      onError: (error) => {
        const e = error as { message?: string; status?: number; code?: string };
        console.error('[patter] model call failed', error);
        return `The model call failed${e.status ? ` (${e.status})` : ''}: ${e.message ?? String(error)}`;
      },
    });
  }
}
