import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { NEW_SESSION_KICKOFF, runConversation, userMessage } from '../../src/app/session.js';
import { fakeQuery, ScriptedIO, sdk } from '../support/fakeSdk.js';

const options = {} as Options;

describe('userMessage', () => {
  it('builds a top-level SDK user message', () => {
    expect(userMessage('hi')).toEqual({ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null });
  });
});

describe('runConversation', () => {
  it('kicks off, relays each agent turn and feeds the user replies back until /quit', async () => {
    const { query, prompts } = fakeQuery((text, turn) => [
      sdk.text(`turn ${turn}: you said "${text}"`),
      sdk.toolUse('mcp__cv__get_profile'),
      sdk.result({ total_cost_usd: 0.1 * (turn + 1) }),
    ]);
    const io = new ScriptedIO(['I am a developer', ' /QUIT ']);
    const summary = await runConversation({ io, query, options });

    expect(prompts).toEqual([NEW_SESSION_KICKOFF, 'I am a developer']);
    expect(io.said).toEqual([`turn 0: you said "${NEW_SESSION_KICKOFF}"`, 'turn 1: you said "I am a developer"']);
    expect(io.statuses).toEqual(['Reading your profile', 'Reading your profile']);
    expect(summary).toEqual({ sessionId: 'sess-1', turns: 2, costUsd: 0.2, endedBy: 'user' });
  });

  it('uses a custom kickoff (e.g. when resuming)', async () => {
    const { query, prompts } = fakeQuery(() => [sdk.result()]);
    await runConversation({ io: new ScriptedIO([null]), query, options, kickoff: 'back again' });
    expect(prompts).toEqual(['back again']);
  });

  it('shows subagent tool activity but not subagent text', async () => {
    const { query } = fakeQuery(() => [
      sdk.toolUse('Agent', { subagent_type: 'cv-writer' }),
      sdk.toolUse('mcp__cv__save_cv_version', {}, 'tu'),
      sdk.text('internal writer notes', 'tu'),
      sdk.text('Here is your draft.'),
      sdk.result(),
    ]);
    const io = new ScriptedIO([null]);
    await runConversation({ io, query, options });
    expect(io.said).toEqual(['Here is your draft.']);
    expect(io.statuses).toEqual([
      'Handing over to the CV writer — this can take a few minutes',
      'cv-writer: Saving a CV draft and running checks',
    ]);
  });

  it('ends when the user leaves (EOF)', async () => {
    const { query } = fakeQuery(() => [sdk.result()]);
    const io = new ScriptedIO([null]);
    expect((await runConversation({ io, query, options })).endedBy).toBe('user');
  });

  it('reports failed turns and lets the user carry on', async () => {
    const { query, prompts } = fakeQuery((_t, turn) =>
      turn === 0
        ? [sdk.result({ subtype: 'error_max_turns', errors: ['too many turns'] })]
        : [sdk.result({ is_error: true, result: 'API overloaded' })],
    );
    const io = new ScriptedIO(['retry', null]);
    await runConversation({ io, query, options });
    expect(prompts).toHaveLength(2);
    expect(io.statuses).toEqual([
      'That turn stopped early (error_max_turns: too many turns). You can carry on.',
      'Something went wrong: API overloaded',
    ]);
  });

  it('stops without asking for input when the budget is exhausted', async () => {
    const { query } = fakeQuery(() => [sdk.result({ subtype: 'error_max_budget_usd', total_cost_usd: 5 })]);
    const io = new ScriptedIO(['never read']);
    const summary = await runConversation({ io, query, options });
    expect(summary).toMatchObject({ endedBy: 'budget', costUsd: 5 });
    expect(io.reads).toBe(0);
    expect(io.statuses[0]).toMatch(/Spending limit reached \(\$5\.00\)/);
  });

  it('returns when the SDK stream ends on its own', async () => {
    const query = async function* () {
      yield sdk.init('s2');
    };
    const summary = await runConversation({ io: new ScriptedIO([]), query, options });
    expect(summary).toEqual({ sessionId: 's2', turns: 0, costUsd: 0, endedBy: 'stream-end' });
  });

  it('propagates SDK failures', async () => {
    const query = async function* () {
      yield sdk.init();
      throw new Error('process exited');
    };
    await expect(runConversation({ io: new ScriptedIO([]), query, options })).rejects.toThrow('process exited');
  });
});
