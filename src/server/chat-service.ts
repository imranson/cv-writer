import { randomUUID } from 'node:crypto';
import type { ChatData, Repo, User } from '../db/repo.js';
import { AbortError, runAgent, type AgentDeps } from '../agents/runner.js';
import { applyEvent, emptyActivity, finalizeActivity, type Activity } from '../shared/activity.js';
import type { AgentEvent } from '../shared/events.js';
import type { ChatMessage } from '../llm/types.js';

export interface Turn {
  id: string;
  user: string;
  answer: string;
  status: 'done' | 'error' | 'aborted';
  error?: string;
  focusJobId?: string | null;
  activity: Activity;
  startedAt: string;
  endedAt: string;
}

type Listener = (e: AgentEvent) => void;

/** In-flight turn: buffered events (for re-attaching after a reload) + live listeners. */
interface LiveTurn {
  turnId: string;
  userId: string;
  userText: string;
  events: AgentEvent[];
  activity: Activity;
  listeners: Set<Listener>;
  controller: AbortController;
  done: Promise<void>;
}

export class BusyError extends Error {
  constructor() {
    super('This chat is already working on a reply. Wait for it to finish or stop it.');
  }
}

/**
 * Runs coordinator turns. A turn keeps running if the browser disconnects; clients can re-attach to
 * the live event stream and the final turn (with its full activity tree) is persisted to the chat
 * session JSON.
 */
export class ChatService {
  private readonly live = new Map<string, LiveTurn>();

  constructor(
    private readonly repo: Repo,
    private readonly deps: AgentDeps,
  ) {}

  isBusy(chatId: string): boolean {
    return this.live.has(chatId);
  }

  liveTurn(userId: string, chatId: string): { turnId: string; userText: string; activity: Activity } | null {
    const t = this.live.get(chatId);
    return t && t.userId === userId ? { turnId: t.turnId, userText: t.userText, activity: t.activity } : null;
  }

  stop(userId: string, chatId: string): boolean {
    const t = this.live.get(chatId);
    if (!t || t.userId !== userId) return false;
    t.controller.abort();
    return true;
  }

  /** Subscribes to a live turn, replaying buffered events first. Returns null if nothing is running. */
  subscribe(userId: string, chatId: string, listener: Listener): { unsubscribe: () => void; done: Promise<void> } | null {
    const t = this.live.get(chatId);
    if (!t || t.userId !== userId) return null;
    for (const e of t.events) listener(e);
    t.listeners.add(listener);
    return { unsubscribe: () => t.listeners.delete(listener), done: t.done };
  }

  /** Starts a turn and returns once it is registered (events flow to subscribers). */
  async start(opts: {
    user: User;
    chatId: string;
    text: string;
    focusJobId?: string | null;
    timeZone?: string;
    /** Subscribed atomically before the turn begins, so no event can be missed. */
    listener?: Listener;
  }): Promise<{ turnId: string; subscription: { unsubscribe: () => void; done: Promise<void> } | null }> {
    const { user, chatId } = opts;
    if (this.live.has(chatId)) throw new BusyError();
    const chat = await this.repo.getChat(user.id, chatId); // ownership check (throws NotFoundError)
    if (this.live.has(chatId)) throw new BusyError();

    const turnId = randomUUID();
    const controller = new AbortController();
    let resolveDone!: () => void;
    const live: LiveTurn = {
      turnId,
      userId: user.id,
      userText: opts.text,
      events: [],
      activity: emptyActivity(),
      listeners: new Set(),
      controller,
      done: new Promise<void>((r) => (resolveDone = r)),
    };
    this.live.set(chatId, live);

    const emit = (e: AgentEvent) => {
      applyEvent(live.activity, e);
      live.events.push(e);
      for (const l of live.listeners) {
        try {
          l(e);
        } catch {
          /* a broken listener must not break the turn */
        }
      }
    };

    const subscription = opts.listener ? this.subscribe(user.id, chatId, opts.listener) : null;
    void this.execute(user, chat.data, chat.title, chatId, opts, live, emit)
      .catch((err) => console.error('[chat] turn failed', err))
      .finally(() => {
        this.live.delete(chatId);
        resolveDone();
      });
    return { turnId, subscription };
  }

  private async execute(
    user: User,
    data: ChatData,
    title: string,
    chatId: string,
    opts: { text: string; focusJobId?: string | null; timeZone?: string },
    live: LiveTurn,
    emit: (e: AgentEvent) => void,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    emit({ type: 'turn_start', turnId: live.turnId, at: startedAt });
    const turns: Turn[] = (data.turns as Turn[]) ?? [];
    const history: ChatMessage[] = (data.messages as ChatMessage[]) ?? [];

    if (turns.length === 0 && title === 'New chat') {
      const newTitle = opts.text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
      await this.repo.saveChat(user.id, chatId, { title: newTitle });
      emit({ type: 'chat_title', title: newTitle });
    }

    let focusJobId = opts.focusJobId ?? null;
    if (focusJobId) {
      await this.repo.getJob(user.id, focusJobId).catch(() => (focusJobId = null));
    }

    let answer = '';
    let status: Turn['status'] = 'done';
    let error: string | undefined;
    let messages: ChatMessage[];
    try {
      const res = await runAgent(this.deps, {
        agent: 'coordinator',
        userId: user.id,
        input: opts.text,
        history,
        emit,
        signal: live.controller.signal,
        focusJobId,
        timeZone: opts.timeZone,
        extraInfo: async () => {
          const jobs = await this.repo.listJobs(user.id);
          const focus = jobs.find((j) => j.id === focusJobId);
          return [
            `Signed-in user: ${user.name || '(no name)'} <${user.email}>`,
            `Jobs on file: ${jobs.length}`,
            focus
              ? `Job selected in the UI: ${focus.id} — ${focus.title || 'untitled'}${focus.company ? ` at ${focus.company}` : ''} (CV ${focus.hasCv ? 'written' : 'not written yet'})`
              : 'Job selected in the UI: none',
          ];
        },
      });
      answer = res.output;
      messages = res.messages;
    } catch (err) {
      status = err instanceof AbortError ? 'aborted' : 'error';
      error = status === 'aborted' ? 'Stopped by user' : (err as Error).message;
      answer = status === 'aborted' ? '_Stopped before finishing._' : `Sorry — something went wrong: ${error}`;
      // Keep the transcript consistent: the user message plus a short note, without dangling tool calls.
      messages = [
        ...history,
        { role: 'user', content: opts.text },
        { role: 'assistant', content: `(My previous reply was interrupted: ${error}.)` },
      ];
    }

    finalizeActivity(live.activity, status === 'error' ? 'error' : 'aborted');
    const turn: Turn = {
      id: live.turnId,
      user: opts.text,
      answer,
      status,
      error,
      focusJobId,
      activity: live.activity,
      startedAt,
      endedAt: new Date().toISOString(),
    };
    await this.repo.saveChat(user.id, chatId, {
      data: { ...data, messages, turns: [...turns, turn], focusJobId },
    });
    emit({ type: 'turn_end', turnId: live.turnId, status, answer, at: turn.endedAt });
  }

  /** Waits for every in-flight turn (graceful shutdown / tests). */
  async drain(): Promise<void> {
    await Promise.all([...this.live.values()].map((t) => t.done));
  }

  abortAll(): void {
    for (const t of this.live.values()) t.controller.abort();
  }
}
