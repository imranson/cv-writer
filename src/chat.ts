import type { Message } from 'ollama';
import { runAgent } from './agents/runner';
import type { AgentDeps, EmitInput, StreamEvent } from './agents/types';
import type { ActivityEvent, ChatSession } from './store';

export class SessionBusyError extends Error {
  constructor() {
    super('This conversation is already running a turn');
  }
}

export class NotFoundError extends Error {}

/**
 * After an interrupted run, an assistant message may have tool calls without results.
 * Adds placeholder results so the history stays valid for the next turn.
 */
export function repairToolPairs(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    const calls = m.role === 'assistant' ? (m.tool_calls ?? []) : [];
    if (calls.length === 0) continue;
    let answered = 0;
    while (messages[i + 1]?.role === 'tool' && answered < calls.length) {
      out.push(messages[++i]);
      answered++;
    }
    for (const call of calls.slice(answered)) {
      out.push({ role: 'tool', tool_name: call.function.name, content: 'Error: interrupted before this tool finished.' });
    }
  }
  return out;
}

export function titleFrom(content: string): string {
  const line = content.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New conversation';
}

export interface SendMessageOptions {
  userId: string;
  sessionId: string;
  content: string;
  activeJobId?: string;
  emit: (event: StreamEvent) => void;
  signal?: AbortSignal;
}

export class ChatService {
  private running = new Set<string>();

  constructor(private deps: AgentDeps) {}

  isRunning(userId: string, sessionId: string): boolean {
    return this.running.has(`${userId}:${sessionId}`);
  }

  async sendMessage(opts: SendMessageOptions): Promise<{ session: ChatSession; text: string }> {
    const { userId, sessionId, content } = opts;
    const key = `${userId}:${sessionId}`;
    if (this.running.has(key)) throw new SessionBusyError();
    this.running.add(key);
    try {
      const session = await this.deps.store.getSession(userId, sessionId);
      if (!session) throw new NotFoundError('Session not found');
      const at = () => new Date().toISOString();

      const record = (event: StreamEvent) => {
        if (event.type !== 'delta') session.events.push(event as ActivityEvent);
        if (event.type === 'usage') session.usage[event.agent] = event.usage;
        opts.emit(event);
      };
      const emit = (event: EmitInput) => record({ ...event, at: at() } as StreamEvent);

      session.events.push({ type: 'user_message', at: at(), content });
      if (session.messages.length === 0 && session.title === 'New conversation') session.title = titleFrom(content);
      const history: Message[] = [...session.messages, { role: 'user', content }];

      try {
        const result = await runAgent({
          deps: this.deps,
          agent: 'coordinator',
          userId,
          messages: history,
          emit,
          signal: opts.signal,
          activeJobId: opts.activeJobId,
          previousUsage: session.usage.coordinator,
        });
        session.messages = result.messages;
        const saved = await this.deps.store.saveSession(userId, session);
        return { session: saved, text: result.text };
      } catch (err: any) {
        const reason = opts.signal?.aborted ? 'Stopped by the user' : (err?.message ?? String(err));
        const partial: Message[] = err?.partialMessages ?? history;
        session.messages = [...repairToolPairs(partial), { role: 'assistant', content: `[This turn was interrupted: ${reason}]` }];
        emit({ type: 'error', message: reason });
        await this.deps.store.saveSession(userId, session);
        throw err;
      }
    } finally {
      this.running.delete(key);
    }
  }
}
