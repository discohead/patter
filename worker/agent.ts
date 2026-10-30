// The patter agent: a Durable Object that holds one session's conversation
// (SQLite, via AIChatAgent) and talks to DeepSeek V4.1 Flash on Workers AI
// through AI Gateway. Every tool is a client tool: the model calls it here,
// the browser runs it against the live SuperSonic engine, and AIChatAgent
// continues the turn when the results come back.
//
// It also keeps the session's checkpoints: the patch as it was when each
// message was sent ('before'), when each turn finished ('after'), and when
// the person asked ('manual'). A branch starts from one of them.

import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import { createAI } from 'agents/models/ai-sdk';
import { convertToModelMessages, jsonSchema, streamText, tool, type ToolSet, type UIMessage } from 'ai';
import { contextPrompt, systemPrompt, type AgentContext } from '../src/agent/prompt';
import { TOOL_DEFS } from '../src/agent/tool-defs';
import { MAX_DOC_CHARS } from './library';

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
  /** The whole patch document then (a checkpoint). */
  patchDoc?: string;
  /** Where the session lives and the AGENTS.md files it reads. */
  context?: AgentContext;
  settings?: { effort?: 'off' | 'low' | 'high' };
}

export type CheckpointKind = 'before' | 'after' | 'manual';
export interface CheckpointMeta {
  id: string;
  /** The message it belongs to (a manual one: the last message when it was made). */
  at: string | null;
  kind: CheckpointKind;
  label: string | null;
  modules: number;
  created: number;
}
export interface Conversation {
  messages: UIMessage[];
  states: { message_id: string; state: string }[];
  checkpoints: (CheckpointMeta & { doc: string })[];
}

const modulesIn = (doc: string) => {
  try {
    return Object.keys((JSON.parse(doc) as { modules?: object }).modules ?? {}).length;
  } catch {
    return 0;
  }
};

export class PatterAgent extends AIChatAgent<Env> {
  private tables() {
    this.sql`CREATE TABLE IF NOT EXISTS patch_states (message_id TEXT PRIMARY KEY, state TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY, at TEXT, kind TEXT NOT NULL, label TEXT, doc TEXT NOT NULL, modules INTEGER NOT NULL, created INTEGER NOT NULL)`;
  }

  async onChatMessage(onFinish: Parameters<AIChatAgent<Env>['onChatMessage']>[0], options?: OnChatMessageOptions): Promise<Response> {
    this.tables();
    const body = (options?.body ?? {}) as Body;
    const messages = this.messages;

    // Remember what the patch looked like when each user message was sent, and
    // replay it with that message every time — a stable prefix for the cache.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!options?.continuation && lastUser) {
      if (typeof body.patchState === 'string') {
        this.sql`INSERT OR REPLACE INTO patch_states (message_id, state) VALUES (${lastUser.id}, ${body.patchState.slice(0, 40_000)})`;
      }
      if (typeof body.patchDoc === 'string' && body.patchDoc.length <= MAX_DOC_CHARS) {
        const exists = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM checkpoints WHERE at = ${lastUser.id} AND kind = 'before'`[0]?.n;
        if (!exists) {
          this.sql`INSERT INTO checkpoints (id, at, kind, label, doc, modules, created)
            VALUES (${crypto.randomUUID()}, ${lastUser.id}, 'before', NULL, ${body.patchDoc}, ${modulesIn(body.patchDoc)}, ${Date.now()})`;
        }
      }
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
      // The long prompt first (it never changes), then this session's context.
      system: body.context ? `${SYSTEM}\n\n${contextPrompt(body.context)}` : SYSTEM,
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

  // ── RPC from the Worker (the library's API). Each one makes sure the agent
  // has started (its messages loaded) first, as the SDK's own RPC methods do.

  /** The conversation, its patch states and its checkpoints (for a branch to copy). */
  async exportConversation(): Promise<Conversation> {
    await this.__unsafe_ensureInitialized();
    this.tables();
    return {
      messages: this.messages,
      states: [...this.sql<{ message_id: string; state: string }>`SELECT message_id, state FROM patch_states`],
      checkpoints: [...this.sql<CheckpointMeta & { doc: string }>`SELECT id, at, kind, label, doc, modules, created FROM checkpoints ORDER BY created`],
    };
  }

  /** Start this (new) session as a copy of part of another's. */
  async importConversation(c: Conversation): Promise<void> {
    await this.__unsafe_ensureInitialized();
    this.tables();
    await this.persistMessages(c.messages);
    for (const s of c.states) this.sql`INSERT OR REPLACE INTO patch_states (message_id, state) VALUES (${s.message_id}, ${s.state})`;
    for (const k of c.checkpoints) {
      this.sql`INSERT OR REPLACE INTO checkpoints (id, at, kind, label, doc, modules, created)
        VALUES (${k.id}, ${k.at}, ${k.kind}, ${k.label}, ${k.doc}, ${k.modules}, ${k.created})`;
    }
  }

  async listCheckpoints(): Promise<CheckpointMeta[]> {
    await this.__unsafe_ensureInitialized();
    this.tables();
    return [...this.sql<CheckpointMeta>`SELECT id, at, kind, label, modules, created FROM checkpoints ORDER BY created`];
  }

  async getCheckpoint(id: string): Promise<(CheckpointMeta & { doc: string }) | null> {
    await this.__unsafe_ensureInitialized();
    this.tables();
    return this.sql<CheckpointMeta & { doc: string }>`SELECT id, at, kind, label, doc, modules, created FROM checkpoints WHERE id = ${id}`[0] ?? null;
  }

  /** Keep the patch as a checkpoint. A turn's 'after' checkpoint is replaced as the turn goes on. */
  async putCheckpoint(input: { at: string | null; kind: CheckpointKind; label?: string | null; doc: string }): Promise<CheckpointMeta> {
    await this.__unsafe_ensureInitialized();
    this.tables();
    const now = Date.now();
    const modules = modulesIn(input.doc);
    if (input.kind === 'after' && input.at) {
      const existing = this.sql<{ id: string }>`SELECT id FROM checkpoints WHERE at = ${input.at} AND kind = 'after'`[0];
      if (existing) {
        this.sql`UPDATE checkpoints SET doc = ${input.doc}, modules = ${modules}, created = ${now} WHERE id = ${existing.id}`;
        return { id: existing.id, at: input.at, kind: 'after', label: null, modules, created: now };
      }
    }
    const id = crypto.randomUUID();
    const label = input.label ?? null;
    this.sql`INSERT INTO checkpoints (id, at, kind, label, doc, modules, created) VALUES (${id}, ${input.at}, ${input.kind}, ${label}, ${input.doc}, ${modules}, ${now})`;
    return { id, at: input.at, kind: input.kind, label, modules, created: now };
  }

  /** The session is deleted: forget everything. */
  async wipe(): Promise<void> {
    await this.destroy();
  }
}
