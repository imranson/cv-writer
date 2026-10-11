import type { AgentEvent } from '../agents/events.js';
import type { AgentRuntime } from '../agents/runtime.js';
import { newId } from '../lib/ids.js';
import type { ChatMessage } from '../llm/types.js';
import type { Workspace } from '../storage/workspace.js';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  usage?: { usedTokens: number; contextWindow: number };
}

/** What the browser receives while a turn runs. */
export type ChatEvent =
  | AgentEvent
  | { type: 'done'; text: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string };

export class SessionNotFoundError extends Error {}
export class SessionBusyError extends Error {}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0];
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New chat';
}

/** Only the coordinator speaks to the user, so subagent text never reaches the browser. */
export function isUserVisible(event: AgentEvent): boolean {
  if (event.type === 'delta' || event.type === 'message') return event.depth === 0;
  return true;
}

export class ChatService {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly workspace: Workspace,
  ) {}

  async list(): Promise<{ id: string; title: string; updatedAt: string; running: boolean }[]> {
    const out = [];
    for (const id of await this.workspace.sessions.list()) {
      const s = (await this.workspace.sessions.read(id)) as unknown as ChatSession | undefined;
      if (s) out.push({ id, title: s.title, updatedAt: s.updatedAt, running: this.running.has(id) });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(): Promise<ChatSession> {
    const now = new Date().toISOString();
    const session: ChatSession = { id: newId('chat'), title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
    await this.save(session);
    return session;
  }

  async get(id: string): Promise<ChatSession | undefined> {
    return (await this.workspace.sessions.read(id)) as unknown as ChatSession | undefined;
  }

  async delete(id: string): Promise<boolean> {
    this.stop(id);
    return this.workspace.sessions.delete(id);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  stop(id: string): boolean {
    const controller = this.running.get(id);
    controller?.abort();
    return controller !== undefined;
  }

  private async save(session: ChatSession): Promise<void> {
    session.updatedAt = new Date().toISOString();
    await this.workspace.sessions.write(session.id, session as unknown as Record<string, unknown>);
  }

  /** Runs one user turn through the coordinator, streaming events and persisting as it goes. */
  async send(sessionId: string, text: string, emit: (event: ChatEvent) => void): Promise<void> {
    // Claim the session synchronously so two concurrent sends can't both start a run.
    if (this.running.has(sessionId)) throw new SessionBusyError('This chat is already working on a reply');
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    const session = await this.get(sessionId).catch(() => undefined);
    if (!session) {
      this.running.delete(sessionId);
      throw new SessionNotFoundError(`Session "${sessionId}" not found`);
    }
    try {
      if (session.messages.length === 0) session.title = titleFrom(text);
      session.messages.push({ role: 'user', content: text });
      await this.save(session);

      // The session keeps all reasoning, but the model doesn't need earlier turns' again; dropping it saves context.
      const history = session.messages.map(({ thinking: _t, ...m }) => m);
      const result = await this.runtime.run('coordinator', history, {
        signal: controller.signal,
        emit: (event) => {
          if (event.type === 'context' && event.depth === 0) {
            session.usage = { usedTokens: event.usedTokens, contextWindow: event.contextWindow };
          }
          if (isUserVisible(event)) emit(event);
        },
        onMessage: (message) => {
          session.messages.push(message);
          return this.save(session);
        },
      });
      await this.save(session);
      emit({ type: 'done', text: result.text });
    } catch (err) {
      await this.save(session).catch(() => {});
      if ((err as Error).name === 'AbortError') emit({ type: 'stopped' });
      else emit({ type: 'error', message: (err as Error).message || String(err) });
    } finally {
      this.running.delete(sessionId);
    }
  }
}
