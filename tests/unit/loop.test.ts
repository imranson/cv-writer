import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentEvent } from '../../src/agents/events.js';
import { runAgent, type AgentSpec } from '../../src/agents/loop.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { defineTool } from '../../src/tools/tool.js';
import { call, calls, say, ScriptedLLM, step } from '../support/scriptedLlm.js';

const add = defineTool({
  name: 'add',
  description: 'Add numbers',
  schema: z.object({ a: z.number(), b: z.number() }),
  run: async ({ a, b }) => ({ sum: a + b }),
});

const spec = (overrides: Partial<AgentSpec> = {}): AgentSpec => ({
  name: 'coordinator',
  model: 'm',
  instructions: 'BASE INSTRUCTIONS',
  tools: [add],
  maxSteps: 5,
  ...overrides,
});

const baseOpts = (llm: ScriptedLLM, events: AgentEvent[] = []) => ({
  llm,
  emit: (e: AgentEvent) => events.push(e),
  depth: 0,
  skills: [{ name: 'tone', description: 'Load before replying', content: 'Be kind.', dir: '' }],
  contextWindow: 10_000,
  now: () => new Date('2026-10-11T09:00:00Z'),
  timeZone: 'UTC',
});

describe('runAgent', () => {
  it('returns a plain reply and streams it', async () => {
    const llm = new ScriptedLLM({ coordinator: () => say('Hello there, how can I help?') });
    const events: AgentEvent[] = [];
    const history: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const result = await runAgent(spec(), history, baseOpts(llm, events));
    expect(result).toMatchObject({ text: 'Hello there, how can I help?', completed: true, contextWindow: 10_000 });
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'Hello there, how can I help?' });
    const streamed = events.filter((e) => e.type === 'delta').map((e) => (e as { content: string }).content).join('');
    expect(streamed).toBe('Hello there, how can I help?');
    expect(events.at(-1)).toEqual({ type: 'message', agent: 'coordinator', depth: 0, content: 'Hello there, how can I help?' });
  });

  it('sends a system prompt with instructions, skills, date/time and context usage', async () => {
    const llm = new ScriptedLLM({ coordinator: () => say('ok') });
    await runAgent(spec(), [{ role: 'user', content: 'hi' }], baseOpts(llm));
    const [req] = llm.requests;
    expect(req.model).toBe('m');
    expect(req.messages[0].role).toBe('system');
    const system = req.messages[0].content;
    expect(system).toContain('BASE INSTRUCTIONS');
    expect(system).toContain('- tone: Load before replying');
    expect(system).not.toContain('Be kind.');
    expect(system).toContain('ISO 2026-10-11T09:00:00+00:00');
    expect(system).toMatch(/Context window: \d+ \/ 10,000 tokens used/);
    expect(req.tools.map((t) => t.function.name)).toEqual(['add']);
    expect(req.think).toBeUndefined();
    await runAgent(spec({ think: false }), [{ role: 'user', content: 'hi' }], baseOpts(llm));
    expect(llm.requests[1].think).toBe(false);
  });

  it('executes tool calls, feeds results back and updates context usage each step', async () => {
    const llm = new ScriptedLLM({
      coordinator: (req) => (step(req) === 0 ? calls(['add', { a: 2, b: 3 }], ['add', { a: 'x' }]) : say('Sum is 5')),
    });
    const events: AgentEvent[] = [];
    const history: ChatMessage[] = [{ role: 'user', content: 'add' }];
    const result = await runAgent(spec(), history, baseOpts(llm, events));
    expect(result.text).toBe('Sum is 5');
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(history[2]).toMatchObject({ tool_name: 'add', content: '{\n "sum": 5\n}' });
    expect(history[3].content).toContain('Error: invalid arguments for add');
    expect(events.filter((e) => e.type === 'tool_result').map((e) => (e as { ok: boolean }).ok)).toEqual([true, false]);
    const contexts = events.filter((e) => e.type === 'context') as { usedTokens: number }[];
    expect(contexts.length).toBeGreaterThanOrEqual(4);
    expect(contexts.at(-1)!.usedTokens).toBeGreaterThan(contexts[0].usedTokens);
    // the second request shows the updated usage to the model
    expect(llm.requests[1].messages[0].content).toContain(`${contexts[2].usedTokens.toLocaleString('en-US')} / 10,000`);
  });

  it('stops after maxSteps', async () => {
    const llm = new ScriptedLLM({ coordinator: () => call('add', { a: 1, b: 1 }) });
    const result = await runAgent(spec({ maxSteps: 3 }), [{ role: 'user', content: 'loop' }], baseOpts(llm));
    expect(result).toMatchObject({ completed: false, text: '[coordinator stopped after 3 steps without a final answer]' });
    expect(llm.requests).toHaveLength(3);
  });

  it('aborts cleanly and keeps the history well-formed', async () => {
    const controller = new AbortController();
    const slow = defineTool({
      name: 'slow',
      description: '',
      schema: z.object({}),
      run: async () => {
        controller.abort();
        return 'done';
      },
    });
    const llm = new ScriptedLLM({ coordinator: () => calls(['slow', {}], ['add', { a: 1, b: 2 }]) });
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }];
    await expect(runAgent(spec({ tools: [slow, add] }), history, { ...baseOpts(llm), signal: controller.signal })).rejects.toThrow('Stopped');
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(history[3].content).toContain('Cancelled');
  });

  it('persists each message through onMessage', async () => {
    const llm = new ScriptedLLM({ coordinator: (req) => (step(req) === 0 ? call('add', { a: 1, b: 2 }) : say('3')) });
    const seen: string[] = [];
    await runAgent(spec(), [{ role: 'user', content: 'x' }], { ...baseOpts(llm), onMessage: (m) => void seen.push(m.role) });
    expect(seen).toEqual(['assistant', 'tool', 'assistant']);
  });
});
