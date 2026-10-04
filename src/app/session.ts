import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from './asyncQueue.js';
import { describeToolUse } from './describe.js';

export interface ChatIO {
  /** Next message from the user, or null when they have left (EOF / Ctrl+C). */
  readUserInput(): Promise<string | null>;
  /** Text from the coordinator. */
  say(text: string): void;
  /** Activity and errors, shown less prominently. */
  status(text: string): void;
}

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

export const EXIT_COMMANDS = new Set(['/quit', '/exit', '/q']);
export const NEW_SESSION_KICKOFF = 'Hi! I would like some help with my CV.';
export const RESUME_KICKOFF = "I'm back — let's continue where we left off.";

export interface SessionSummary {
  sessionId?: string;
  turns: number;
  costUsd: number;
  endedBy: 'user' | 'budget' | 'stream-end';
}

export function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

/**
 * Runs one conversation with the coordinator in streaming-input mode: a single
 * long-lived agent session, fed one user turn after each completed agent turn.
 */
export async function runConversation(params: {
  io: ChatIO;
  query: QueryFn;
  options: Options;
  kickoff?: string;
}): Promise<SessionSummary> {
  const { io, query, options, kickoff = NEW_SESSION_KICKOFF } = params;
  const input = new AsyncQueue<SDKUserMessage>();
  const summary: SessionSummary = { turns: 0, costUsd: 0, endedBy: 'stream-end' };

  input.push(userMessage(kickoff));
  try {
    for await (const msg of query({ prompt: input, options })) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        summary.sessionId = msg.session_id;
      } else if (msg.type === 'assistant') {
        const fromSubagent = msg.parent_tool_use_id !== null;
        for (const block of msg.message.content) {
          if (block.type === 'text' && !fromSubagent && block.text.trim()) io.say(block.text.trim());
          if (block.type === 'tool_use') {
            const label = describeToolUse(block.name, block.input, fromSubagent);
            if (label) io.status(label);
          }
        }
      } else if (msg.type === 'result') {
        summary.turns += 1;
        summary.costUsd = msg.total_cost_usd;
        if (msg.subtype === 'error_max_budget_usd') {
          io.status(`Spending limit reached ($${msg.total_cost_usd.toFixed(2)}). Everything so far has been saved.`);
          summary.endedBy = 'budget';
          input.close();
          continue;
        }
        if (msg.subtype !== 'success') {
          io.status(`That turn stopped early (${msg.subtype}${msg.errors.length ? `: ${msg.errors.join('; ')}` : ''}). You can carry on.`);
        } else if (msg.is_error) {
          io.status(`Something went wrong: ${msg.result}`);
        }
        if (input.isClosed) continue;
        const reply = await io.readUserInput();
        if (reply === null || EXIT_COMMANDS.has(reply.trim().toLowerCase())) {
          summary.endedBy = 'user';
          input.close();
        } else {
          input.push(userMessage(reply));
        }
      }
    }
  } finally {
    input.close();
  }
  return summary;
}
