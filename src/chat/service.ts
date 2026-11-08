import type { AgentRuntime } from '../agents/runtime.js';
import { isPersistable, now, type AgentEvent } from '../agents/events.js';
import type { ChatSession, Repo } from '../db/repo.js';
import type { ChatMessage } from '../llm/types.js';

export class SessionBusyError extends Error {
  constructor() {
    super('This chat is already working on a reply. Wait for it to finish or stop it.');
  }
}

export class SessionNotFoundError extends Error {
  constructor() {
    super('Chat session not found');
  }
}

type Listener = (event: AgentEvent) => void;

export interface ActiveRun {
  sessionId: string;
  userId: string;
  events: AgentEvent[];
  listeners: Set<Listener>;
  controller: AbortController;
  done: Promise<void>;
}

export interface ChatServiceOptions {
  /** Maximum persisted activity events per session (oldest dropped first). */
  maxActivity?: number;
  /** Maximum characters of a tool result kept in persisted activity. */
  maxStoredResultChars?: number;
}

export function deriveTitle(content: string): string {
  const line = content.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New chat';
}

/** Transcript as shown in the chat pane: user turns and assistant replies with text. */
export function visibleMessages(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: string; at?: string }[] {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content, at: m.at }));
}

/**
 * Runs coordinator turns for chat sessions. A run is decoupled from the HTTP
 * request that started it: clients subscribe (with replay) and can re-attach
 * after a reload; the transcript and activity are persisted when the turn ends.
 */
export class ChatService {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly maxActivity: number;
  private readonly maxStoredResultChars: number;

  constructor(
    private readonly repo: Repo,
    private readonly runtime: AgentRuntime,
    opts: ChatServiceOptions = {},
  ) {
    this.maxActivity = opts.maxActivity ?? 4000;
    this.maxStoredResultChars = opts.maxStoredResultChars ?? 20_000;
  }

  isBusy(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  /** Starts a coordinator turn. Resolves once the run is registered (not when it finishes). */
  async start(userId: string, sessionId: string, content: string, opts: { timezone?: string } = {}): Promise<ActiveRun> {
    if (this.runs.has(sessionId)) throw new SessionBusyError();
    let resolveDone!: () => void;
    const run: ActiveRun = {
      sessionId,
      userId,
      events: [],
      listeners: new Set(),
      controller: new AbortController(),
      done: new Promise<void>((r) => (resolveDone = r)),
    };
    this.runs.set(sessionId, run); // registered synchronously so concurrent starts are rejected

    let session: ChatSession | null;
    try {
      session = await this.repo.getChatSession(userId, sessionId);
    } catch (err) {
      this.runs.delete(sessionId);
      throw err;
    }
    if (!session) {
      this.runs.delete(sessionId);
      throw new SessionNotFoundError();
    }

    void this.execute(run, session, content, opts.timezone).finally(() => {
      this.runs.delete(sessionId);
      resolveDone();
    });
    return run;
  }

  /** Subscribes to a running turn, replaying events emitted so far. Returns null when idle. */
  subscribe(userId: string, sessionId: string, listener: Listener): (() => void) | null {
    const run = this.runs.get(sessionId);
    if (!run || run.userId !== userId) return null;
    for (const e of run.events) listener(e);
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  stop(userId: string, sessionId: string): boolean {
    const run = this.runs.get(sessionId);
    if (!run || run.userId !== userId) return false;
    run.controller.abort(new Error('Stopped by user'));
    return true;
  }

  async waitIdle(sessionId: string): Promise<void> {
    await this.runs.get(sessionId)?.done;
  }

  async shutdown(): Promise<void> {
    for (const run of this.runs.values()) run.controller.abort(new Error('Server shutting down'));
    await Promise.all([...this.runs.values()].map((r) => r.done));
  }

  private async execute(run: ActiveRun, session: ChatSession, content: string, timezone?: string): Promise<void> {
    const emit = (event: AgentEvent) => {
      run.events.push(event);
      for (const l of run.listeners) {
        try {
          l(event);
        } catch {
          run.listeners.delete(l);
        }
      }
    };

    const history = (session.data.messages ?? []) as ChatMessage[];
    const userMessage: ChatMessage = { role: 'user', content, at: now() };
    let messages: ChatMessage[] = [...history, userMessage];
    emit({ type: 'user_message', content, at: userMessage.at! });

    try {
      const result = await this.runtime.runCoordinator({
        userId: run.userId,
        messages,
        task: content,
        emit,
        signal: run.controller.signal,
        timezone,
      });
      messages = result.messages;
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && !last.tool_calls?.length) last.at = now();
      if (!result.ok) {
        messages.push({
          role: 'assistant',
          content: result.aborted ? '_(Stopped.)_' : `⚠️ Sorry — something went wrong: ${result.final}`,
          at: now(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', message, at: now() });
      messages.push({ role: 'assistant', content: `⚠️ Sorry — something went wrong: ${message}`, at: now() });
    }

    try {
      const activity = [
        ...(session.data.activity ?? []),
        ...run.events.filter(isPersistable).map((e) => this.compactForStorage(e)),
      ].slice(-this.maxActivity);
      await this.repo.saveChatSession(run.userId, run.sessionId, {
        title: session.title === 'New chat' ? deriveTitle(content) : undefined,
        data: { ...session.data, messages: messages.map(stripThinking), activity },
      });
    } catch (err) {
      emit({ type: 'error', message: `Could not save the chat: ${(err as Error).message}`, at: now() });
    }
    emit({ type: 'done', at: now() });
  }

  private compactForStorage(e: AgentEvent): AgentEvent {
    if (e.type === 'tool_end' && e.result.length > this.maxStoredResultChars) {
      return { ...e, result: `${e.result.slice(0, this.maxStoredResultChars)}\n…[truncated for storage]` };
    }
    if (e.type === 'llm_end' && e.thinking && e.thinking.length > this.maxStoredResultChars) {
      return { ...e, thinking: `${e.thinking.slice(0, this.maxStoredResultChars)}…` };
    }
    return e;
  }
}

/** Reasoning traces are kept in activity but not replayed to the model on later turns. */
function stripThinking(m: ChatMessage): ChatMessage {
  if (!m.thinking) return m;
  const { thinking: _t, ...rest } = m;
  return rest;
}
