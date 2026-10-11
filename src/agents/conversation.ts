import { randomUUID } from 'node:crypto';
import { isAbortError, type ChatMessage } from '../llm/types.ts';
import type { ContextUsage, Session, StoredMessage } from '../storage/store.ts';
import { compactSession, contextMessages, estimateContextTokens } from './context.ts';
import { buildCoordinatorSystemPrompt, coordinatorTools, type CoordinatorState } from './coordinator.ts';
import type { AgentDeps } from './deps.ts';
import type { AgentEvent } from './events.ts';
import { runAgent } from './loop.ts';

export type ServerEvent =
  | AgentEvent
  | { type: 'message'; message: StoredMessage }
  | { type: 'context'; context: ContextUsage }
  | { type: 'compacted'; compacted: number }
  | { type: 'session'; session: { id: string; title: string; jobId: string | null } }
  | { type: 'done'; stoppedBy: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string };

export type ServerEmit = (event: ServerEvent) => void;

export class BusyError extends Error {
  constructor() {
    super('The assistant is still working on the previous message.');
    this.name = 'BusyError';
  }
}

export interface ConversationOptions {
  /** Fraction of the context window at which older messages are compacted before a turn. */
  compactThreshold: number;
  keepRecent?: number;
  maxSteps?: number;
}

const DEFAULT_TITLE = 'New conversation';

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || DEFAULT_TITLE;
}

/** Runs coordinator turns for chat sessions, persisting every message as it is produced. */
export class ConversationService {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly deps: AgentDeps,
    private readonly opts: ConversationOptions,
  ) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  stop(sessionId: string): boolean {
    const controller = this.running.get(sessionId);
    controller?.abort();
    return Boolean(controller);
  }

  async contextLimit(): Promise<number> {
    return this.deps.models.coordinator.contextLength();
  }

  /** Current context usage: the model-reported figure when available, otherwise an estimate. */
  async contextUsage(session: Session): Promise<ContextUsage> {
    const limit = await this.contextLimit();
    if (!session.context.estimated && session.context.tokens > 0) return { ...session.context, limit };
    const system = await buildCoordinatorSystemPrompt(this.deps, session);
    return { tokens: estimateContextTokens(system, contextMessages(session)), limit, estimated: true };
  }

  async compact(sessionId: string, emit: ServerEmit = () => {}): Promise<Session> {
    if (this.running.has(sessionId)) throw new BusyError();
    const session = await this.deps.store.requireSession(sessionId);
    return this.compactLoaded(session, emit);
  }

  private async compactLoaded(session: Session, emit: ServerEmit, signal?: AbortSignal): Promise<Session> {
    const { session: next, compacted } = await compactSession(session, this.deps.models.coordinator, {
      keepRecent: this.opts.keepRecent,
      signal,
    });
    if (!compacted) return session;
    const fresh = { ...next, context: { ...next.context, estimated: true, tokens: 0 } };
    const saved = await this.deps.store.saveSession({ ...fresh, context: await this.contextUsage(fresh) });
    emit({ type: 'compacted', compacted });
    emit({ type: 'context', context: saved.context });
    return saved;
  }

  async sendMessage(sessionId: string, text: string, emit: ServerEmit = () => {}): Promise<Session> {
    if (this.running.has(sessionId)) throw new BusyError();
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    const { store } = this.deps;
    try {
      let session = await store.requireSession(sessionId);
      const stamp = (m: ChatMessage): StoredMessage => ({ ...m, id: randomUUID(), at: new Date().toISOString() });

      const userMessage = stamp({ role: 'user', content: text });
      session.messages.push(userMessage);
      if (session.title === DEFAULT_TITLE) session.title = titleFrom(text);
      session = await store.saveSession(session);
      emit({ type: 'message', message: userMessage });
      emit({ type: 'session', session: { id: session.id, title: session.title, jobId: session.jobId } });

      const limit = await this.contextLimit();
      if (session.context.tokens > limit * this.opts.compactThreshold) {
        session = await this.compactLoaded(session, emit, controller.signal);
      }

      const state: CoordinatorState = { jobId: session.jobId };
      const forward = (event: AgentEvent) => {
        emit(event);
        if (event.type === 'usage' && event.agent === 'coordinator') {
          const context = { tokens: event.promptTokens + event.completionTokens, limit, estimated: false };
          session.context = context;
          emit({ type: 'context', context });
        }
        if (event.type === 'artifact' && event.kind === 'session') {
          emit({ type: 'session', session: { id: session.id, title: session.title, jobId: state.jobId } });
        }
      };

      const system = await buildCoordinatorSystemPrompt(this.deps, session);
      try {
        const result = await runAgent({
          agent: 'coordinator',
          model: this.deps.models.coordinator,
          system,
          history: contextMessages(session),
          tools: coordinatorTools(this.deps, state, { emit: forward, signal: controller.signal }),
          maxSteps: this.opts.maxSteps ?? 16,
          signal: controller.signal,
          emit: forward,
          onMessage: async (message) => {
            const stored = stamp(message);
            session.messages.push(stored);
            session.jobId = state.jobId;
            session = await store.saveSession(session);
            emit({ type: 'message', message: stored });
          },
        });
        if (!result.lastUsage.promptTokens) {
          session.context = { tokens: estimateContextTokens(system, contextMessages(session)), limit, estimated: true };
        }
        session.jobId = state.jobId;
        session = await store.saveSession(session);
        emit({ type: 'context', context: session.context });
        emit({ type: 'done', stoppedBy: result.stoppedBy });
      } catch (err) {
        session.jobId = state.jobId;
        session = await store.saveSession(session);
        if (isAbortError(err) || controller.signal.aborted) {
          emit({ type: 'stopped' });
        } else {
          emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
      return session;
    } finally {
      this.running.delete(sessionId);
    }
  }
}
