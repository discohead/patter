// The conversation, rendered by assistant-ui and carried by Cloudflare Agents:
// useAgent opens the WebSocket to this session's PatterAgent Durable Object,
// useAgentChat streams the turn, useAISDKRuntime adapts it for assistant-ui.
// Tool calls arrive here and run against the live engine, one at a time and
// in order (later calls may depend on modules earlier ones defined). They
// never start audio themselves: a call that arrives first (after a reload
// mid-turn, say) waits for the click and the session's patch. Stopping the
// turn drops every call that hasn't run, for good.
//
// Every message is a place to branch from (assistant-ui's action bars): edit
// or retry one of yours, or go on differently from an answer, and a new
// session starts there with the patch as it was. Where sessions go different
// ways, ‹ n/m › flips between them. ◆ marks the checkpoints along the way.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import {
  ActionBarPrimitive, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAui, useAuiState,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import type { UIMessage } from 'ai';
import { app, useEmitter } from '../app/store';
import { runTool, summarizePatch } from '../agent/tools';
import { subjectOf, textOf, TOOL_LABEL } from '../app/transcript';
import { branchesAt, UNTITLED } from '../app/tree';
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

// ── messages: branching, checkpoints ────────────────────────────────────────

/** The conversation as the agent keeps it (assistant-ui's view joins and renumbers; branches count these). */
const ChatInfo = createContext<{ messages: UIMessage[] }>({ messages: [] });

/** Run an action from a button; say what went wrong. */
const act = (p: Promise<unknown>) => void p.catch((e) => app.showToast((e as Error).message, { error: true }));

function time(t: number) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** ‹ n/m ›: the sessions that go different ways from this message. */
function Branches({ index }: { index: number }) {
  useEmitter(app.uiEvents);
  const list = branchesAt(app.tree.sessions, app.session, index);
  if (list.length < 2) return null;
  const at = Math.max(0, list.indexOf(app.session));
  const titleOf = (n: string) => {
    const t = n === app.session ? app.runtime.doc.title : app.tree.sessions.find((s) => s.name === n)?.title ?? '';
    return t === UNTITLED ? 'untitled session' : t;
  };
  const go = (k: number) => act(app.openSession(list[(k + list.length) % list.length]));
  return (
    <div className="branch-picker" title={list.map((n, i) => `${i + 1}. ${titleOf(n)}${n === app.session ? ' (here)' : ''}`).join('\n')}>
      <button className="ghost tiny" onClick={() => go(at - 1)} aria-label="previous branch">‹</button>
      <span>
        ⑂ {at + 1}/{list.length}
      </span>
      <button className="ghost tiny" onClick={() => go(at + 1)} aria-label="next branch">›</button>
    </div>
  );
}

/** Checkpoints kept by hand after a message (or, `at` null, before any). */
function Marks({ at }: { at: string | null }) {
  useEmitter(app.uiEvents);
  const marks = app.checkpoints.filter((k) => k.kind === 'manual' && k.at === at);
  return (
    <>
      {marks.map((k) => (
        <div key={k.id} className="checkpoint-mark">
          <span className="cp-dot">◆</span>
          <span className="cp-label">{k.label}</span>
          <span className="dim">
            {time(k.created)} · {k.modules} module{k.modules === 1 ? '' : 's'}
          </span>
          <button className="ghost tiny" title="bring this patch back (⌘Z undoes)" onClick={() => act(app.restoreCheckpoint(k.id))}>
            ⟲ restore
          </button>
          <button className="ghost tiny" title="a new branch from here, with this patch" onClick={() => act(app.branchFromCheckpoint(k.id))}>
            ⑂ branch
          </button>
        </div>
      ))}
    </>
  );
}

/** Editing one of your messages: what you send instead goes into a new branch from there. */
function EditComposer({ id }: { id: string }) {
  const aui = useAui();
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const text = aui.composer.getState().text.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      aui.composer.cancel();
      await app.editMessage(id, text);
    } catch (e) {
      app.showToast((e as Error).message, { error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="edit-composer"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void send();
        }
      }}
    >
      <ComposerPrimitive.Input className="composer-input" submitMode="none" autoFocus rows={2} />
      <div className="row end">
        <ComposerPrimitive.Cancel className="ghost">cancel</ComposerPrimitive.Cancel>
        <button disabled={busy} onClick={() => void send()} title="a new session from here: the conversation up to this message, the patch as it was then, and this instead">
          ⑂ branch &amp; send
        </button>
      </div>
    </div>
  );
}

function UserMessage() {
  const { messages } = useContext(ChatInfo);
  const id = useAuiState((s) => s.message.id);
  const editing = useAuiState((s) => s.message.composer.isEditing);
  const index = messages.findIndex((m) => m.id === id);
  return (
    <MessagePrimitive.Root className="msg-wrap user">
      {editing ? (
        <EditComposer id={id} />
      ) : (
        <div className="msg user">
          <MessagePrimitive.Parts components={{ Text: ({ text }) => <>{text}</> }} />
        </div>
      )}
      {!editing && index >= 0 && (
        <div className="msg-foot">
          <Branches index={index} />
          <ActionBarPrimitive.Root className="msg-actions" hideWhenRunning autohide="always">
            <ActionBarPrimitive.Edit className="ghost tiny" title="send something else here instead (in a new branch; this one stays)">
              ✎ edit
            </ActionBarPrimitive.Edit>
            <button className="ghost tiny" title="send it again, from the patch as it was then (in a new branch; this one stays)" onClick={() => act(app.editMessage(id, textOf(messages[index])))}>
              ↻ retry
            </button>
            <ActionBarPrimitive.Copy className="ghost tiny">copy</ActionBarPrimitive.Copy>
          </ActionBarPrimitive.Root>
        </div>
      )}
      <Marks at={id} />
    </MessagePrimitive.Root>
  );
}

function AssistantFooter({ id }: { id: string }) {
  useEmitter(app.uiEvents);
  const after = app.checkpoints.find((k) => k.kind === 'after' && k.at === id);
  return (
    <ActionBarPrimitive.Root className="msg-actions" hideWhenRunning autohide="not-last">
      {after && (
        <span className="cp-dot" title={`checkpoint: the patch as this turn left it (${after.modules} module${after.modules === 1 ? '' : 's'}, ${time(after.created)})`}>
          ◆
        </span>
      )}
      <button className="ghost tiny" title="a new session from here: this conversation so far, and the patch as this turn left it" onClick={() => act(app.branchAfter(id))}>
        ⑂ branch from here
      </button>
      <button
        className="ghost tiny"
        disabled={!after}
        title={after ? 'bring the patch back to how this turn left it (⌘Z undoes)' : 'no checkpoint here (from before they were kept)'}
        onClick={() => after && act(app.restoreCheckpoint(after.id))}
      >
        ⟲ restore
      </button>
      <ActionBarPrimitive.Copy className="ghost tiny">copy</ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}

function AssistantMessage() {
  const id = useAuiState((s) => s.message.id);
  return (
    <MessagePrimitive.Root className="msg-wrap assistant">
      <div className="msg assistant">
        <MessagePrimitive.Parts components={{ Text: TextPart, Reasoning: ReasoningPart, tools: { Fallback: ToolCard } }} />
      </div>
      <AssistantFooter id={id} />
      <Marks at={id} />
    </MessagePrimitive.Root>
  );
}

/** At the end of a branch nothing has been said in yet: where it came from, and the way back. */
function BranchStart({ count }: { count: number }) {
  useEmitter(app.uiEvents);
  const me = app.entry;
  if (!me?.parent || (me.forkKeep !== 'after' && me.forkKeep !== 'before') || count !== me.prefix || app.pendingSend?.session === app.session) return null;
  const parent = app.tree.sessions.find((s) => s.name === me.parent);
  return (
    <div className="branch-start">
      <span>
        ⑂ A branch{parent ? ` of “${parent.title === UNTITLED ? 'untitled session' : parent.title}”` : ''}, from here, with the patch as it was. Say something to go another way.
      </span>
      <Branches index={count} />
      {parent && (
        <button className="ghost tiny" onClick={() => act(app.openSession(parent.name))}>
          back to it
        </button>
      )}
    </div>
  );
}

/** Above the conversation: a new session, a fresh start with this patch, a branch, a checkpoint. */
function ChatBar() {
  useEmitter(app.uiEvents);
  const song = app.song;
  return (
    <div className="chat-bar">
      <button className="ghost" title={`a new session with an empty patch${song ? `, in “${song.name}”` : ''}`} onClick={() => act(app.newSession(app.entry?.songId ?? null))}>
        ＋ new
      </button>
      <button className="ghost" title="clear the conversation: a fresh session with this patch (this one stays in the library)" onClick={() => act(app.freshStart())}>
        ⌫ clear
      </button>
      <button className="ghost" title="branch: a copy of this session that goes its own way (this one stays as it is)" onClick={() => act(app.branch({ keep: 'all' }))}>
        ⑂ branch
      </button>
      <button className="ghost" disabled={app.state !== 'ready'} title="keep the patch as it is now, by name (⌘S)" onClick={() => app.showDialog({ kind: 'checkpoint' })}>
        ◆ checkpoint
      </button>
    </div>
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

function Thread({ count }: { count: number }) {
  useEmitter(app.uiEvents);
  const song = app.song;
  return (
    <ThreadPrimitive.Root className="chat">
      <ChatBar />
      <ThreadPrimitive.Viewport className="chat-list">
        <Marks at={null} />
        <ThreadPrimitive.Empty>
          <div className="chat-hello">
            <p>Describe the system you want to hear.</p>
            <p className="dim">Hold <kbd>space</kbd> (or the mic) to talk. Ask for knobs and macros by name. Change anything while it plays.</p>
            {song && <p className="dim">This session is in “{song.name}”: the agent reads its AGENTS.md.</p>}
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>
          {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
        </ThreadPrimitive.Messages>
        <BranchStart count={count} />
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
  const ctx = {
    runtime: app.runtime,
    seq: app.seq,
    engine: app.engine,
    isStopped: () => app.stopped,
    record: (source: string, bars: number, name?: string) => app.record(source, bars, name),
    context: {
      read: () => {
        const c = app.agentContext();
        return { song: c.song ?? '(none: this session stands on its own)', set: c.set ?? '(none)', person: c.agents || '(empty)' };
      },
      write: (level: 'song' | 'set' | 'person', text: string, mode: 'append' | 'replace') => app.writeContext(level, text, mode),
    },
  };

  const chat = useAgentChat({
    agent,
    body: () => {
      // The patch as it is goes with each message; the agent keeps it as the message's checkpoint.
      return {
        patchState: JSON.stringify({
          ...(summarizePatch(ctx) as object),
          focus: { scope: app.scope || '(top level)', selected: app.selection },
          ...(app.stopped ? { transport: 'stopped' } : {}),
          ...(app.recentActions().length ? { userActions: app.recentActions() } : {}),
        }),
        ...(app.state === 'ready' ? { patchDoc: JSON.stringify(app.runtime.doc) } : {}),
        context: app.agentContext(),
        settings: { effort: app.settings.effort },
      };
    },
    onTurnEnd: (e) => {
      if (e.outcome === 'error' && !e.replay) app.engine.info(`the agent's turn failed: ${e.error ?? 'unknown error'}`);
    },
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
  const messages = chat.messages as UIMessage[];

  useEffect(() => {
    app.chatStop = () => {
      void chat.stop();
    };
    return () => {
      app.chatStop = () => {};
    };
  }, [chat]);

  // The session's bookkeeping: how many messages the person has sent (the first names an untitled session), and the last one.
  useEffect(() => {
    if (name !== app.session) return;
    const mine = messages.filter((m) => m.role === 'user');
    app.lastMessageId = messages[messages.length - 1]?.id ?? null;
    app.setTurns(mine.length, textOf(mine[0]));
  }, [messages, name]);

  // A turn that ran here and finished (no tool call still waiting): keep the patch as it left it.
  const ran = useRef(false);
  const status = chat.status;
  useEffect(() => {
    if (status === 'submitted' || status === 'streaming') {
      ran.current = true;
      return;
    }
    if (status !== 'ready' || !ran.current) return;
    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant') return;
    const waiting = last.parts.some((p) => {
      const st = (p as { state?: string }).state;
      return (p.type.startsWith('tool-') || p.type === 'dynamic-tool') && st !== 'output-available' && st !== 'output-error';
    });
    if (waiting) return;
    const t = setTimeout(() => {
      ran.current = false;
      void queue.current.then(() => app.afterTurn(last.id));
    }, 600);
    return () => clearTimeout(t);
  }, [status, messages]);

  // An edit or a retry made this branch: send its message once the connection has settled — the agent
  // knows it, its conversation is here, nothing is streaming or being resumed. A send while the chat is
  // still connecting can lose its turn (or its tool calls), so it waits a moment and looks again.
  const settled = agent.identified && status === 'ready' && !chat.isServerStreaming && !chat.isRecovering;
  const settledRef = useRef(settled);
  settledRef.current = settled && messages.length >= (app.pendingSend?.prefix ?? 0);
  useEffect(() => {
    const p = app.pendingSend;
    if (!p || p.session !== name || !settled || messages.length < p.prefix) return;
    const t = setTimeout(() => {
      if (app.pendingSend !== p || !settledRef.current) return;
      app.pendingSend = null;
      void chat.sendMessage({ text: p.text });
    }, 400);
    return () => clearTimeout(t);
  }, [messages.length, settled, name, chat]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatInfo.Provider value={{ messages }}>
        {chat.connectionError && <div className="msg note error">agent connection: {String(chat.connectionError.message ?? chat.connectionError)}</div>}
        {chat.error && <div className="msg note error">{chat.error.message}</div>}
        <Thread count={messages.length} />
      </ChatInfo.Provider>
    </AssistantRuntimeProvider>
  );
}
