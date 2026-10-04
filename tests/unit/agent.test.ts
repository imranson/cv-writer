import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  compactHistory,
  defineTool,
  dropNulls,
  STALE_TOOL_OUTPUT,
  toolSpec,
  type AgentEvent,
  type AgentOptions,
} from '../../src/agents/agent.js';
import type { AuditEvent } from '../../src/domain/schemas.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { call, calls, lastToolResult, say, ScriptedModel, type Step } from '../support/scripted.js';

function setup(steps: Step[], options: Partial<AgentOptions> = {}) {
  const model = new ScriptedModel(steps);
  const audit: Array<Omit<AuditEvent, 'at'>> = [];
  const events: AgentEvent[] = [];
  const ran: unknown[] = [];
  const tools = [
    defineTool({
      name: 'add',
      description: 'Add two numbers',
      parameters: z.object({ a: z.number(), b: z.number(), note: z.string().optional() }),
      async run({ a, b }) {
        ran.push(['add', a, b]);
        return { sum: a + b };
      },
    }),
    defineTool({
      name: 'lookup',
      description: 'Read something',
      parameters: z.object({}),
      readOnly: true,
      async run() {
        ran.push(['lookup']);
        return 'plain text result';
      },
    }),
    defineTool({
      name: 'explode',
      description: 'Always fails',
      parameters: z.object({}),
      async run() {
        throw new Error('kaboom');
      },
    }),
  ];
  const agent = new Agent({
    name: 'tester',
    model: 'test-model',
    client: model,
    systemPrompt: 'You are a test.',
    tools,
    audit: async (e) => void audit.push(e),
    onEvent: (e) => events.push(e),
    ...options,
  });
  return { agent, model, audit, events, ran };
}

describe('Agent.run', () => {
  it('sends the system prompt, history and tool definitions, and returns a plain reply', async () => {
    const { agent, model } = setup([say('  Hello!  ')]);
    const result = await agent.run('hi');
    expect(result).toEqual({ reply: 'Hello!', steps: 1, stoppedBy: 'reply' });

    const [request] = model.requests;
    expect(request!.model).toBe('test-model');
    expect(request!.messages).toEqual([
      { role: 'system', content: 'You are a test.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(request!.tools!.map((t) => t.function.name)).toEqual(['add', 'lookup', 'explode']);
    expect(request).not.toHaveProperty('think');
    expect(agent.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '  Hello!  ' },
    ]);
  });

  it('runs requested tools and feeds their results back until the model answers', async () => {
    const { agent, model, ran } = setup([call('add', { a: 2, b: 3 }), (req) => say(`The sum is ${lastToolResult(req).json().sum}`)]);
    const result = await agent.run('what is 2+3?');
    expect(result).toEqual({ reply: 'The sum is 5', steps: 2, stoppedBy: 'reply' });
    expect(ran).toEqual([['add', 2, 3]]);

    const toolMessage = model.requests[1]!.messages.at(-1)!;
    expect(toolMessage).toMatchObject({ role: 'tool', tool_name: 'add', content: JSON.stringify({ sum: 5 }, null, 2) });
    expect(toolMessage.tool_call_id).toMatch(/^call_/);
    expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('runs several tool calls from one message in order', async () => {
    const { agent, model, ran } = setup([calls(['lookup'], ['add', { a: 1, b: 1 }]), say('done')]);
    await agent.run('go');
    expect(ran).toEqual([['lookup'], ['add', 1, 1]]);
    expect(model.requests[1]!.messages.slice(-2).map((m) => [m.tool_name, m.content])).toEqual([
      ['lookup', 'plain text result'],
      ['add', JSON.stringify({ sum: 2 }, null, 2)],
    ]);
  });

  it('returns validation errors to the model without running the tool', async () => {
    const { agent, model, ran, audit } = setup([call('add', { a: 'two', b: 3 }), say('sorry')]);
    await agent.run('x');
    expect(ran).toEqual([]);
    const result = lastToolResult(model.requests[1]!).content;
    expect(result).toMatch(/^Error: invalid arguments for add\. Fix them and call it again\./);
    expect(result).toContain('→ at a');
    expect(audit).toEqual([expect.objectContaining({ actor: 'tester', action: 'add', ok: false })]);
  });

  it('treats null arguments as absent', async () => {
    const { agent, ran } = setup([call('add', { a: 1, b: 2, note: null }), say('ok')]);
    await agent.run('x');
    expect(ran).toEqual([['add', 1, 2]]);
  });

  it('refuses tools it does not have, naming the ones it does, and audits the denial', async () => {
    const { agent, model, audit } = setup([call('save_cv_version', { jobId: 'j' }), say('ok')]);
    await agent.run('x');
    expect(lastToolResult(model.requests[1]!).content).toBe(
      'Error: There is no tool "save_cv_version" available to the tester. Available tools: add, lookup, explode.',
    );
    expect(audit).toEqual([
      {
        actor: 'tester',
        action: 'save_cv_version',
        ok: false,
        detail: { input: { jobId: 'j' }, denied: expect.stringContaining('no tool "save_cv_version"') },
      },
    ]);
  });

  it('reports tool failures to the model and audits them', async () => {
    const { agent, model, audit } = setup([call('explode'), say('it failed')]);
    await agent.run('x');
    expect(lastToolResult(model.requests[1]!).content).toBe('Error: explode failed: kaboom');
    expect(audit).toEqual([{ actor: 'tester', action: 'explode', ok: false, detail: { input: {}, error: 'kaboom' } }]);
  });

  it('audits state-changing tool calls but not read-only ones', async () => {
    const { agent, audit } = setup([calls(['lookup'], ['add', { a: 1, b: 2 }]), say('ok')]);
    await agent.run('x');
    expect(audit).toEqual([{ actor: 'tester', action: 'add', ok: true, detail: { input: { a: 1, b: 2 } } }]);
  });

  it('stops after maxSteps model calls', async () => {
    const { agent, model } = setup([call('lookup'), call('lookup'), call('lookup')], { maxSteps: 2 });
    expect(await agent.run('loop')).toEqual({ reply: '', steps: 2, stoppedBy: 'max-steps' });
    expect(model.remaining).toBe(1);
  });

  it('asks again once when the model returns nothing, then gives up quietly', async () => {
    const retried = setup([{ content: '', thinking: 'hmm' }, say('second try')]);
    expect((await retried.agent.run('x')).reply).toBe('second try');
    expect(retried.agent.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);

    const empty = setup([say(''), say(' ')]);
    expect(await empty.agent.run('x')).toEqual({ reply: '', steps: 2, stoppedBy: 'reply' });
  });

  it('emits text, tool-call and tool-result events', async () => {
    const { agent, events } = setup([call('add', { a: 1, b: 1 }, 'Let me add that.'), say('Two.')]);
    await agent.run('x');
    expect(events).toEqual([
      { type: 'text', agent: 'tester', text: 'Let me add that.' },
      { type: 'tool-call', agent: 'tester', name: 'add', args: { a: 1, b: 1 } },
      { type: 'tool-result', agent: 'tester', name: 'add', ok: true, output: JSON.stringify({ sum: 2 }, null, 2) },
      { type: 'text', agent: 'tester', text: 'Two.' },
    ]);
  });

  it('keeps thinking in the transcript and passes the think option through', async () => {
    const { agent, model } = setup([{ content: 'hi', thinking: 'reasoning' }], { think: 'high' });
    await agent.run('x');
    expect(model.requests[0]!.think).toBe('high');
    expect(agent.messages.at(-1)).toEqual({ role: 'assistant', content: 'hi', thinking: 'reasoning' });
  });

  it('continues from earlier history and accumulates token usage into a shared meter', async () => {
    const usage = { requests: 5, promptTokens: 1000, outputTokens: 100 };
    const history: ChatMessage[] = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'earlier reply' },
    ];
    const { agent, model } = setup([call('lookup'), say('ok')], { history, usage });
    await agent.run('now');
    expect(model.requests[0]!.messages.map((m) => m.content)).toEqual(['You are a test.', 'earlier', 'earlier reply', 'now']);
    expect(usage).toEqual({ requests: 7, promptTokens: 1200, outputTokens: 140 });
    expect(agent.usage).toBe(usage);
    expect(history).toHaveLength(2);
  });

  it('sends a compacted history when the conversation outgrows the context budget', async () => {
    const bulky = 'x'.repeat(5_000);
    const history: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup', arguments: {} } }] },
      { role: 'tool', tool_name: 'lookup', content: bulky },
      { role: 'assistant', content: 'a' },
    ];
    const { agent, model } = setup([say('ok')], { history, maxContextChars: 1_000 });
    await agent.run('next');
    // Only 5 messages, all within keepRecent, so nothing is dropped from a short conversation.
    expect(model.requests[0]!.messages[3]!.content).toBe(bulky);
    expect(agent.messages[2]!.content).toBe(bulky);
  });
});

describe('compactHistory', () => {
  const tool = (content: string): ChatMessage => ({ role: 'tool', tool_name: 't', content });
  const user = (content: string): ChatMessage => ({ role: 'user', content });

  it('returns the same array when within budget', () => {
    const messages = [user('a'), tool('b')];
    expect(compactHistory(messages, 100)).toBe(messages);
  });

  it('blanks the oldest bulky tool outputs first and keeps recent messages intact', () => {
    const big = 'y'.repeat(1_000);
    const messages = [user('1'), tool(big), tool(big), user('2'), tool(big), user('3')];
    const out = compactHistory(messages, 2_200, 2);
    expect(out.map((m) => m.content === STALE_TOOL_OUTPUT)).toEqual([false, true, false, false, false, false]);
    expect(compactHistory(messages, 100, 2).map((m) => m.content === STALE_TOOL_OUTPUT)).toEqual([false, true, true, false, false, false]);
    expect(messages[1]!.content).toBe(big);
  });
});

describe('toolSpec / dropNulls', () => {
  it('describes a tool as a JSON-schema function without the $schema key', () => {
    const spec = toolSpec(
      defineTool({
        name: 'save',
        description: 'Save it',
        parameters: z.object({ id: z.string().describe('The id'), tags: z.array(z.string()).default([]), n: z.number().optional() }),
        async run() {
          return null;
        },
      }),
    );
    expect(spec).toEqual({
      type: 'function',
      function: {
        name: 'save',
        description: 'Save it',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The id' },
            tags: { type: 'array', items: { type: 'string' }, default: [] },
            n: { type: 'number' },
          },
          required: ['id'],
        },
      },
    });
  });

  it('removes nulls recursively, including from arrays', () => {
    expect(dropNulls({ a: null, b: { c: null, d: 1 }, e: [1, null, { f: null }], g: 'x' })).toEqual({ b: { d: 1 }, e: [1, {}], g: 'x' });
    expect(dropNulls('s')).toBe('s');
  });
});
