import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatIO, QueryFn } from '../../src/app/session.js';

/** Minimal stand-ins for the SDK message shapes the session loop reads. */
export const sdk = {
  init: (sessionId = 'sess-1') => ({ type: 'system', subtype: 'init', session_id: sessionId }) as unknown as SDKMessage,
  text: (text: string, parent: string | null = null) =>
    ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text }] } }) as unknown as SDKMessage,
  toolUse: (name: string, input: unknown = {}, parent: string | null = null, id = 'tu') =>
    ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } }) as unknown as SDKMessage,
  result: (fields: Record<string, unknown> = {}) =>
    ({ type: 'result', subtype: 'success', is_error: false, result: '', errors: [], total_cost_usd: 0.01, ...fields }) as unknown as SDKMessage,
};

export const textOf = (m: SDKUserMessage) => (typeof m.message.content === 'string' ? m.message.content : '');

/**
 * A fake `query` that answers each user turn with scripted messages. The responder may be
 * async (e.g. to run real tools) and receives the turn index.
 */
export function fakeQuery(respond: (text: string, turn: number) => SDKMessage[] | Promise<SDKMessage[]>) {
  const prompts: string[] = [];
  const query: QueryFn = async function* ({ prompt }) {
    yield sdk.init();
    let turn = 0;
    for await (const message of prompt) {
      prompts.push(textOf(message));
      for (const out of await respond(textOf(message), turn++)) yield out;
    }
  };
  return { query, prompts };
}

/** A user who replies from a script (null = leaves). */
export class ScriptedIO implements ChatIO {
  readonly said: string[] = [];
  readonly statuses: string[] = [];
  reads = 0;

  constructor(private readonly replies: Array<string | null | (() => string | null | Promise<string | null>)>) {}

  async readUserInput(): Promise<string | null> {
    this.reads += 1;
    const next = this.replies.shift();
    if (next === undefined) return null;
    return typeof next === 'function' ? next() : next;
  }

  say(text: string): void {
    this.said.push(text);
  }

  status(text: string): void {
    this.statuses.push(text);
  }
}
