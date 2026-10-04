import type { Agent, AgentEvent } from '../agents/agent.js';
import { createCoordinator } from '../agents/coordinator.js';
import { runCvWriter } from '../agents/cvWriter.js';
import { COORDINATOR, NEW_SESSION_KICKOFF, RESUME_KICKOFF } from '../agents/prompts.js';
import type { PdfRenderer } from '../cv/export.js';
import type { CvVersion } from '../domain/schemas.js';
import { LlmError } from '../llm/ollama.js';
import { emptyUsage, type ChatClient, type Think, type Usage } from '../llm/types.js';
import type { CvStore } from '../storage/store.js';
import type { PageFetcher } from '../web/fetchPage.js';
import { describeToolCall, describeToolResult } from './describe.js';

export interface ChatIO {
  /** Next message from the user, or null when they have left (EOF / Ctrl+C). */
  readUserInput(): Promise<string | null>;
  /** Text from the coordinator. */
  say(text: string): void;
  /** Activity and errors, shown less prominently. */
  status(text: string): void;
  /** A CV version, shown exactly as stored. */
  showCv(cv: CvVersion): void;
}

export const EXIT_COMMANDS = new Set(['/quit', '/exit', '/q']);

export interface SessionSummary {
  sessionId: string;
  turns: number;
  usage: Usage;
  endedBy: 'user' | 'error';
  error?: string;
}

/** Routes agent activity to the user: coordinator text in full, tool use as status lines, writer text hidden. */
export function presentEvents(io: ChatIO): (event: AgentEvent) => void {
  return (event) => {
    if (event.type === 'text') {
      if (event.agent === COORDINATOR) io.say(event.text);
    } else if (event.type === 'tool-call') {
      const label = describeToolCall(event.name, event.args, event.agent);
      if (label) io.status(label);
    } else {
      const label = describeToolResult(event);
      if (label) io.status(label);
    }
  };
}

/**
 * The conversation loop: one coordinator, fed one user message after each of its turns,
 * until the user leaves. The transcript is saved after every turn.
 */
export async function runConversation(params: {
  io: ChatIO;
  coordinator: Agent;
  sessionId: string;
  kickoff?: string;
  afterTurn?: () => Promise<void>;
}): Promise<SessionSummary> {
  const { io, coordinator, sessionId, kickoff = NEW_SESSION_KICKOFF, afterTurn } = params;
  let input: string | null = kickoff;
  let turns = 0;

  while (input !== null) {
    try {
      const result = await coordinator.run(input);
      if (result.stoppedBy === 'max-steps') {
        io.status('That took more steps than expected, so I paused. Say "continue" to carry on.');
      } else if (!result.reply) {
        io.status('(No reply from the model. Try rephrasing, or say "continue".)');
      }
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof LlmError && err.fatal) {
        await afterTurn?.();
        io.status(message);
        return { sessionId, turns, usage: coordinator.usage, endedBy: 'error', error: message };
      }
      io.status(`Something went wrong: ${message}. Everything saved so far is kept; you can try again.`);
    }
    turns += 1;
    await afterTurn?.();

    const reply = await io.readUserInput();
    input = reply === null || EXIT_COMMANDS.has(reply.trim().toLowerCase()) ? null : reply;
  }
  return { sessionId, turns, usage: coordinator.usage, endedBy: 'user' };
}

export interface SessionOptions {
  store: CvStore;
  client: ChatClient;
  io: ChatIO;
  model: string;
  writerModel: string;
  think?: Think;
  /** A session id to continue, or 'latest'. */
  resume?: string;
  fetchPage?: PageFetcher;
  pdf?: PdfRenderer;
  today?: string;
}

/** Wires the coordinator, the cv-writer and storage together and runs (or resumes) a conversation. */
export async function startSession(options: SessionOptions): Promise<SessionSummary> {
  const { store, client, io, model, writerModel, think, resume, today } = options;
  const existing = resume ? (resume === 'latest' ? await store.latestSession() : await store.getSession(resume)) : undefined;
  if (resume && !existing) {
    throw new Error(resume === 'latest' ? 'There is no earlier conversation to continue.' : `No saved conversation "${resume}".`);
  }

  const id = existing?.id ?? store.newId('session');
  const createdAt = existing?.createdAt ?? store.timestamp();
  const usage = existing ? { ...existing.usage } : emptyUsage();
  const onEvent = presentEvents(io);
  const shared = { ...(think !== undefined ? { think } : {}), ...(today ? { today } : {}) };

  const coordinator = createCoordinator({
    store,
    client,
    model,
    usage,
    onEvent,
    ...shared,
    ...(existing ? { history: existing.messages } : {}),
    ...(options.fetchPage ? { fetchPage: options.fetchPage } : {}),
    ...(options.pdf ? { pdf: options.pdf } : {}),
    showCv: (cv) => io.showCv(cv),
    writeCv: (task) => runCvWriter(task, { store, client, model: writerModel, sessionId: id, onEvent, usage, ...shared }),
  });

  return runConversation({
    io,
    coordinator,
    sessionId: id,
    kickoff: existing ? RESUME_KICKOFF : NEW_SESSION_KICKOFF,
    afterTurn: async () => {
      await store.saveSession({
        id,
        createdAt,
        updatedAt: store.timestamp(),
        model,
        writerModel,
        messages: coordinator.messages,
        usage,
      });
    },
  });
}
