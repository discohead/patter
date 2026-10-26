// The conversation, rendered by assistant-ui and carried by Cloudflare Agents:
// useAgent opens the WebSocket to this session's PatterAgent Durable Object,
// useAgentChat streams the turn, useAISDKRuntime adapts it for assistant-ui.
// Tool calls arrive here and run against the live engine, one at a time and
// in order (later calls may depend on modules earlier ones defined). They
// never start audio themselves: a call that arrives first (after a reload
// mid-turn, say) waits for the click and the session's patch. Stopping the
// turn drops every call that hasn't run, for good.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import {
  AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAui, useAuiState,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { app, useEmitter } from '../app/store';
import { runTool, summarizePatch } from '../agent/tools';
import { PushToTalk, speechSupported } from './speech';

// ── text rendering ──────────────────────────────────────────────────────────

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('`') ? <code key={k++}>{t.slice(1, -1)}</code> : <strong key={k++}>{t.slice(2, -2)}</strong>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** Just enough markdown for replies: paragraphs, lists, `code`, ```blocks```, **bold**. */
export function renderText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(/```(?:\w+)?\n?/).forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(<pre key={`c${i}`} className="md-code">{part.replace(/\n$/, '')}</pre>);
      return;
    }
    part.split(/\n{2,}/).forEach((b, j) => {
      if (!b.trim()) return;
      const lines = b.split('\n');
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l) || !l.trim())) {
        out.push(<ul key={`l${i}-${j}`}>{lines.filter((l) => l.trim()).map((l, k) => <li key={k}>{inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>)}</ul>);
      } else {
        out.push(<p key={`p${i}-${j}`}>{lines.map((l, k) => <span key={k}>{inline(l)}{k < lines.length - 1 && <br />}</span>)}</p>);
      }
    });
  });
  return out;
}

function TextPart({ text }: { text: string }) {
  return <>{renderText(text)}</>;
}

function ReasoningPart({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text?.trim()) return null;
  return (
    <div className="thinking">
      <button className="ghost" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} reasoning</button>
      {open && <div className="thinking-body">{renderText(text)}</div>}
    </div>
  );
}

// ── tool calls ──────────────────────────────────────────────────────────────

const TOOL_LABEL: Record<string, string> = {
  define_module: 'module', remove_module: 'remove', set_params: 'knobs', modulate: 'patch',
  define_macro: 'macro', remove_macro: 'remove macro', define_routine: 'routine', routine_control: 'routine',
  set_tempo: 'tempo', mix: 'mix', expose_controls: 'surface', listen: 'listen', inspect: 'inspect',
  graph: 'graph', trace: 'trace', ugen_reference: 'reference', clear_patch: 'clear', annotate: 'notes',
  subpatch: 'subpatch', abstraction: 'abstraction',
};

function subjectOf(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
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

function ToolCard(props: ToolCallMessagePartProps) {
  useEmitter(app.uiEvents);
  const { toolName, toolCallId, args, result, status } = props;
  const [open, setOpen] = useState(false);
  const a = args as Record<string, unknown> | undefined;
  const code = typeof a?.code === 'string' ? (a.code as string) : null;
  const text = typeof result === 'string' ? result : result === undefined ? '' : JSON.stringify(result);
  const failed = text.startsWith('ERROR:');
  const pending = status.type === 'running' || (status.type === 'requires-action' && result === undefined);
  const notRun = pending && app.abandoned.has(toolCallId);
  const running = pending && !notRun;
  const state = notRun ? 'stopped' : running ? 'running' : failed ? 'error' : 'ok';
  return (
    <div className={`tool tool-${state}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-dot" />
        <span>{TOOL_LABEL[toolName] ?? toolName}{subjectOf(toolName, a) ? ` · ${subjectOf(toolName, a)}` : ''}</span>
        {failed && <span className="tool-err">{text.slice(7, 100)}</span>}
        {notRun && <span className="tool-note">not run: stopped</span>}
      </button>
      {(open || (running && code)) && (
        <div className="tool-body">
          {code && <pre className="md-code">{code}</pre>}
          {open && !code && a && <pre className="md-code">{JSON.stringify(a, null, 1)}</pre>}
          {open && text && <pre className={failed ? 'error' : 'result'}>{text}</pre>}
        </div>
      )}
    </div>
  );
}

// ── messages & composer ─────────────────────────────────────────────────────

function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg user">
      <MessagePrimitive.Parts components={{ Text: ({ text }) => <>{text}</> }} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="msg assistant">
      <MessagePrimitive.Parts components={{ Text: TextPart, Reasoning: ReasoningPart, tools: { Fallback: ToolCard } }} />
    </MessagePrimitive.Root>
  );
}

function Composer() {
  useEmitter(app.uiEvents);
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const ptt = useRef<PushToTalk | null>(null);
  if (!ptt.current) ptt.current = new PushToTalk(setInterim, (m) => console.warn(m));

  const start = useCallback(() => {
    if (!speechSupported || ptt.current!.listening) return;
    setInterim('');
    setListening(true);
    ptt.current!.start();
  }, []);
  const end = useCallback(async () => {
    if (!ptt.current!.listening) return;
    const heard = await ptt.current!.stop();
    setListening(false);
    setInterim('');
    if (!heard) return;
    const composer = aui.composer;
    const draft = composer.getState().text;
    composer.setText(draft ? `${draft} ${heard}` : heard);
    if (app.settings.autoSendVoice && !running) composer.send();
  }, [aui, running]);

  // Hold space (outside text fields) to talk.
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !isField(e.target)) {
        e.preventDefault();
        start();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isField(e.target)) {
        e.preventDefault();
        void end();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [start, end]);

  return (
    <ComposerPrimitive.Root className={`chat-input${listening ? ' listening' : ''}`}>
      {listening && <div className="interim">{interim || 'listening…'}</div>}
      <ComposerPrimitive.Input
        rows={3}
        placeholder="e.g. a Turing machine sequencer into a pinged resonant filter, with a 'tension' macro"
        className="composer-input"
      />
      <div className="row between">
        <div className="row">
          {speechSupported ? (
            <button
              type="button"
              className={`mic${listening ? ' on' : ''}`}
              onPointerDown={start}
              onPointerUp={() => void end()}
              onPointerLeave={() => listening && void end()}
              title="hold to talk (or hold space)"
            >
              ● {listening ? 'listening' : 'hold to talk'}
            </button>
          ) : (
            <span className="dim">voice input needs Chrome, Edge or Safari</span>
          )}
        </div>
        <div className="row">
          {running ? (
            <ComposerPrimitive.Cancel className="danger">stop</ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send>send</ComposerPrimitive.Send>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function Thread() {
  return (
    <ThreadPrimitive.Root className="chat">
      <ThreadPrimitive.Viewport className="chat-list">
        <ThreadPrimitive.Empty>
          <div className="chat-hello">
            <p>Describe the system you want to hear.</p>
            <p className="dim">Hold <kbd>space</kbd> (or the mic) to talk. Ask for knobs and macros by name. Change anything while it plays.</p>
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>
          {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      <Composer />
    </ThreadPrimitive.Root>
  );
}

// ── the connection ──────────────────────────────────────────────────────────

/** The chat for the current session (App remounts it, keyed by session, when that changes). */
export function AgentChat() {
  const [name] = useState(() => app.session);
  const agent = useAgent({ agent: 'PatterAgent', name });
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const ctx = { runtime: app.runtime, seq: app.seq, engine: app.engine, isStopped: () => app.stopped };

  const chat = useAgentChat({
    agent,
    body: () => ({
      patchState: JSON.stringify({
        ...(summarizePatch(ctx) as object),
        focus: { scope: app.scope || '(top level)', selected: app.selection },
        ...(app.stopped ? { transport: 'stopped' } : {}),
        ...(app.recentActions().length ? { userActions: app.recentActions() } : {}),
      }),
      settings: { effort: app.settings.effort },
    }),
    onToolCall: async ({ toolCall, addToolOutput }) => {
      const id = toolCall.toolCallId;
      if (app.abandoned.has(id)) return; // its turn was stopped (maybe before a reload)
      const generation = app.agentGeneration;
      const stale = () => generation !== app.agentGeneration || name !== app.session;
      const run = async () => {
        if (app.state !== 'ready') {
          app.waitingTools++;
          app.uiEvents.emit();
          try {
            await app.whenReady();
          } finally {
            app.waitingTools--;
            app.uiEvents.emit();
          }
        }
        if (stale()) return app.abandon(id, name);
        const outcome = await runTool(toolCall.toolName, toolCall.input, ctx);
        // Stopped while it ran: the change stands, but the turn doesn't go on.
        if (stale()) return app.abandon(id, name);
        // Errors go back as ordinary output so the turn continues and the model can fix them.
        addToolOutput({ toolCallId: id, output: outcome.isError ? `ERROR: ${outcome.content}` : outcome.content });
        const subject = (toolCall.input as { name?: string } | null)?.name;
        if (toolCall.toolName === 'define_module' && !outcome.isError && subject) app.reveal(subject);
      };
      const p = queue.current.then(run, run);
      queue.current = p.catch(() => undefined);
      await p;
    },
  });
  const runtime = useAISDKRuntime(chat as unknown as Parameters<typeof useAISDKRuntime>[0]);

  useEffect(() => {
    app.clearConversation = () => chat.clearHistory();
    app.chatStop = () => {
      void chat.stop();
    };
    return () => {
      app.chatStop = () => {};
    };
  }, [chat]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {chat.connectionError && <div className="msg note error">agent connection: {String(chat.connectionError.message ?? chat.connectionError)}</div>}
      {chat.error && <div className="msg note error">{chat.error.message}</div>}
      <Thread />
    </AssistantRuntimeProvider>
  );
}
