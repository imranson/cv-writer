import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentEvent } from '../../src/agents/events.ts';
import { executeToolCall, preview, runAgent } from '../../src/agents/loop.ts';
import { defineTool, toToolSchema, ToolError } from '../../src/agents/tool.ts';
import { isAbortError, type ChatMessage } from '../../src/llm/types.ts';
import { call, calls, say, ScriptedModel, waitForAbort } from '../support/scriptedModel.ts';

const echo = defineTool({
  name: 'echo',
  description: 'Echo text back',
  schema: z.object({ text: z.string().min(1), times: z.number().int().default(1) }),
  async run({ text, times }) {
    return text.repeat(times);
  },
});
const boom = defineTool({
  name: 'boom',
  description: 'Always fails',
  schema: z.object({}),
  async run() {
    throw new ToolError('kaboom');
  },
});
const submit = defineTool({
  name: 'submit',
  description: 'Terminal tool',
  schema: z.object({ value: z.string() }),
  terminal: true,
  async run({ value }) {
    return `got ${value}`;
  },
});

function collect() {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => events.push(e) };
}

describe('toToolSchema', () => {
  it('converts zod schemas to JSON-schema function parameters', () => {
    const schema = toToolSchema(echo);
    expect(schema.name).toBe('echo');
    expect(schema.parameters).toMatchObject({ type: 'object', properties: { text: { type: 'string' }, times: { type: 'integer' } }, required: ['text'] });
    expect(schema.parameters).not.toHaveProperty('$schema');
  });
});

describe('executeToolCall', () => {
  it('validates arguments and reports unknown tools and tool errors as text', async () => {
    const ctx = { emit: () => {} };
    expect(await executeToolCall([echo], 'echo', { text: 'ab', times: 2 }, ctx)).toMatchObject({ ok: true, output: 'abab' });
    expect((await executeToolCall([echo], 'echo', { text: '' }, ctx)).output).toMatch(/^Error: invalid arguments for echo: text:/);
    expect((await executeToolCall([echo], 'nope', {}, ctx)).output).toMatch(/unknown tool "nope". Available tools: echo/);
    expect(await executeToolCall([boom], 'boom', {}, ctx)).toMatchObject({ ok: false, output: 'Error: kaboom' });
  });
});

describe('runAgent', () => {
  it('returns the final answer when the model replies without tools', async () => {
    const model = new ScriptedModel([say('Hello there')]);
    const { events, emit } = collect();
    const r = await runAgent({ agent: 'coordinator', model, system: 'SYS', history: [{ role: 'user', content: 'hi' }], tools: [echo], emit });
    expect(r).toMatchObject({ finalText: 'Hello there', stoppedBy: 'final', steps: 1 });
    expect(model.requests[0]!.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(model.requests[0]!.tools?.map((t) => t.name)).toEqual(['echo']);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello there');
    expect(events.some((e) => e.type === 'usage')).toBe(true);
  });

  it('executes tool calls, feeds results back and records every message in order', async () => {
    const model = new ScriptedModel([calls(['echo', { text: 'x', times: 3 }], ['boom', {}]), say('Done')]);
    const recorded: ChatMessage[] = [];
    const { events, emit } = collect();
    const r = await runAgent({ agent: 'writer', model, system: 's', history: [], tools: [echo, boom], emit, onMessage: (m) => void recorded.push(m) });
    expect(r.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'assistant']);
    expect(r.messages[1]).toEqual({ role: 'tool', toolName: 'echo', content: 'xxx' });
    expect(r.messages[2]).toEqual({ role: 'tool', toolName: 'boom', content: 'Error: kaboom' });
    expect(recorded).toEqual(r.messages);
    // second request includes the tool results
    expect(model.requests[1]!.messages.slice(-2).map((m) => m.content)).toEqual(['xxx', 'Error: kaboom']);
    const ends = events.filter((e) => e.type === 'tool_end');
    expect(ends.map((e) => [e.name, e.ok])).toEqual([['echo', true], ['boom', false]]);
    expect(r.totalUsage.promptTokens).toBeGreaterThan(0);
  });

  it('stops after a successful terminal tool call, but not after a failed one', async () => {
    const model = new ScriptedModel([call('submit', {}), call('submit', { value: 'v' })]);
    const r = await runAgent({ agent: 'critic', model, system: 's', history: [], tools: [submit] });
    expect(r.stoppedBy).toBe('terminal_tool');
    expect(r.terminalOutput).toBe('got v');
    expect(r.messages[1]!.content).toMatch(/^Error: invalid arguments/);
  });

  it('forces a final answer without tools when the step limit is reached', async () => {
    const model = new ScriptedModel([call('echo', { text: 'a' }), call('echo', { text: 'b' }), say('Summary')]);
    const r = await runAgent({ agent: 'writer', model, system: 's', history: [], tools: [echo], maxSteps: 2 });
    expect(r).toMatchObject({ stoppedBy: 'max_steps', finalText: 'Summary' });
    expect(model.requests[2]!.tools).toBeUndefined();
  });

  it('retries once when the model returns an empty reply', async () => {
    const model = new ScriptedModel([say(''), say('Second try')]);
    const r = await runAgent({ agent: 'coordinator', model, system: 's', history: [], tools: [] });
    expect(r.finalText).toBe('Second try');
    expect(r.messages).toHaveLength(1);
  });

  it('strips reasoning from earlier turns but keeps it within the current run', async () => {
    const model = new ScriptedModel([{ ...call('echo', { text: 'a' }), thinking: 'plan' }, say('ok')]);
    const history: ChatMessage[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', thinking: 'old reasoning' }];
    await runAgent({ agent: 'coordinator', model, system: 's', history, tools: [echo] });
    expect(model.requests[0]!.messages.some((m) => m.thinking)).toBe(false);
    expect(model.requests[1]!.messages.find((m) => m.toolCalls)?.thinking).toBe('plan');
  });

  it('aborts promptly when the signal fires', async () => {
    const controller = new AbortController();
    const model = new ScriptedModel([(req) => waitForAbort(req)]);
    const run = runAgent({ agent: 'coordinator', model, system: 's', history: [], tools: [], signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toSatisfy(isAbortError);
  });
});

describe('preview', () => {
  it('truncates long tool output', () => {
    expect(preview('x'.repeat(500), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(preview('  short  ')).toBe('short');
  });
});
