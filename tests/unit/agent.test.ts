import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { compactHistory, defineTool, progressReporter, runAgent, toolSpec, ToolError, type AgentEvent } from '../../src/agents/agent.js';
import type { ChatMessage } from '../../src/domain/schemas.js';
import { call, lastToolResult, say, ScriptedModel } from '../support/scripted.js';

const add = defineTool({
  name: 'add',
  description: 'Add two numbers',
  schema: z.object({ a: z.number(), b: z.number(), note: z.string().optional() }),
  mutates: true,
  label: (x) => `Adding ${x.a}+${x.b}`,
  run: async ({ a, b, note }) => ({ sum: a + b, note: note ?? null }),
});
const fail = defineTool({ name: 'fail', description: 'Always fails', schema: z.object({}), run: async () => { throw new ToolError('nope, try X'); } });

function audit() {
  const records: Array<{ actor: string; action: string; outcome: string; details?: unknown }> = [];
  return { records, audit: async (r: (typeof records)[number]) => void records.push(r) };
}

const base = (llm: ScriptedModel, extra: Partial<Parameters<typeof runAgent>[0]> = {}) => ({
  name: 'coordinator' as const,
  model: 'm',
  llm,
  system: () => 'system prompt',
  tools: [add, fail],
  ...extra,
});

describe('runAgent', () => {
  it('runs tools, feeds results back, and returns the final reply', async () => {
    const llm = new ScriptedModel({ m: [call('add', { a: 2, b: 3 }, 'Let me add.'), say('The sum is 5.')] });
    const events: AgentEvent[] = [];
    const sink = audit();
    const result = await runAgent(base(llm, { emit: (e) => events.push(e), audit: sink }), [{ role: 'user', content: 'add 2 and 3' }]);
    expect(result.reply).toBe('The sum is 5.');
    expect(result.stoppedBy).toBe('reply');
    expect(lastToolResult(llm.requests[1]!)).toEqual({ sum: 5, note: null });
    expect(result.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(result.usage).toEqual({ promptTokens: 200, outputTokens: 40, calls: 2 });
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'note', agent: 'coordinator', text: 'Let me add.' },
        { type: 'tool_start', agent: 'coordinator', tool: 'add', label: 'Adding 2+3' },
        { type: 'tool_end', agent: 'coordinator', tool: 'add', ok: true, label: 'Adding 2+3' },
      ]),
    );
    expect(sink.records).toEqual([{ actor: 'coordinator', action: 'add', outcome: 'ok', details: { args: { a: 2, b: 3 } } }]);
  });

  it('sends the rebuilt system prompt and tool specs on every call', async () => {
    let n = 0;
    const llm = new ScriptedModel({ m: [call('add', { a: 1, b: 1 }), say('ok')] });
    await runAgent(base(llm, { system: () => `state ${++n}` }), [{ role: 'user', content: 'hi' }]);
    expect(llm.requests.map((r) => r.messages[0]!.content)).toEqual(['state 1', 'state 2']);
    expect(llm.requests[0]!.tools!.map((t) => t.function.name)).toEqual(['add', 'fail']);
  });

  it('returns validation errors to the model so it can correct itself; nulls count as absent', async () => {
    const llm = new ScriptedModel({ m: [call('add', { a: 'two', b: 3 }), call('add', { a: 2, b: 3, note: null }), say('done')] });
    const sink = audit();
    await runAgent(base(llm, { audit: sink }), [{ role: 'user', content: 'x' }]);
    expect(String(lastToolResult(llm.requests[1]!).error)).toMatch(/Invalid arguments for add/);
    expect(lastToolResult(llm.requests[2]!)).toEqual({ sum: 5, note: null });
    expect(sink.records[0]).toMatchObject({ action: 'add', outcome: 'error' });
  });

  it('refuses tools the agent does not have, and audits the attempt', async () => {
    const llm = new ScriptedModel({ m: [call('delete_everything'), say('sorry')] });
    const sink = audit();
    await runAgent(base(llm, { audit: sink }), [{ role: 'user', content: 'x' }]);
    expect(String(lastToolResult(llm.requests[1]!).error)).toMatch(/not available to you\. Available tools: add, fail/);
    expect(sink.records[0]).toMatchObject({ action: 'delete_everything', outcome: 'refused' });
  });

  it('reports tool failures to the model', async () => {
    const llm = new ScriptedModel({ m: [call('fail'), say('it failed')] });
    const events: AgentEvent[] = [];
    await runAgent(base(llm, { emit: (e) => events.push(e) }), [{ role: 'user', content: 'x' }]);
    expect(lastToolResult(llm.requests[1]!)).toEqual({ error: 'nope, try X' });
    expect(events).toContainEqual({ type: 'tool_end', agent: 'coordinator', tool: 'fail', ok: false, label: 'fail' });
  });

  it('handles unparseable arguments', async () => {
    const llm = new ScriptedModel({ m: [call('add', { __unparseable: '{a:' }), say('ok')] });
    await runAgent(base(llm), [{ role: 'user', content: 'x' }]);
    expect(String(lastToolResult(llm.requests[1]!).error)).toMatch(/not valid JSON/);
  });

  it('nudges once after an empty reply, then falls back', async () => {
    const llm = new ScriptedModel({ m: [say(''), say('here')] });
    expect((await runAgent(base(llm), [{ role: 'user', content: 'x' }])).reply).toBe('here');
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/last reply was empty/);
    const llm2 = new ScriptedModel({ m: [say(''), say('')] });
    expect((await runAgent(base(llm2), [{ role: 'user', content: 'x' }])).reply).toMatch(/did not manage to produce a reply/);
  });

  it('lets beforeFinish send the model back to work (at most twice)', async () => {
    const llm = new ScriptedModel({ m: [say('done?'), say('done!'), say('really done')] });
    const before = vi.fn().mockReturnValue('You forgot something.');
    const result = await runAgent(base(llm, { beforeFinish: before }), [{ role: 'user', content: 'x' }]);
    expect(before).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe('really done');
    expect(llm.requests[1]!.messages.at(-1)).toEqual({ role: 'user', content: 'You forgot something.' });
  });

  it('stops at the step limit with an honest message', async () => {
    const llm = new ScriptedModel({ m: Array(3).fill(call('add', { a: 1, b: 1 })) });
    const sink = audit();
    const result = await runAgent(base(llm, { maxSteps: 3, audit: sink }), [{ role: 'user', content: 'x' }]);
    expect(result.stoppedBy).toBe('max_steps');
    expect(result.reply).toMatch(/ran out of steps/);
    expect(sink.records.at(-1)).toMatchObject({ action: 'max_steps', outcome: 'error' });
  });

  it('streams deltas only when asked', async () => {
    const llm = new ScriptedModel({ m: [say('hello there'), say('again')] });
    const events: AgentEvent[] = [];
    await runAgent(base(llm, { stream: true, emit: (e) => events.push(e) }), [{ role: 'user', content: 'x' }]);
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { content: string }).content).join('')).toBe('hello there');
    events.length = 0;
    await runAgent(base(llm, { emit: (e) => events.push(e) }), [{ role: 'user', content: 'x' }]);
    expect(events.filter((e) => e.type === 'delta')).toEqual([]);
  });
});

describe('progressReporter', () => {
  it('reports characters generated so far, at most once per interval, and restarts on reset', () => {
    const events: AgentEvent[] = [];
    let t = 0;
    const report = progressReporter('critic', (e) => events.push(e), 1000, () => t);
    t = 1000;
    report({ thinking: 'abcd' });
    t = 1500;
    report({ thinking: 'efgh' });
    t = 2100;
    report({ content: 'ij' });
    report({ reset: true });
    t = 3200;
    report({ content: 'k' });
    expect(events).toEqual([
      { type: 'progress', agent: 'critic', chars: 4 },
      { type: 'progress', agent: 'critic', chars: 10 },
      { type: 'progress', agent: 'critic', chars: 1 },
    ]);
  });

  it('is used when an agent streams for progress only', async () => {
    const llm = new ScriptedModel({ m: [say('a long considered answer')] });
    const events: AgentEvent[] = [];
    await runAgent(base(llm, { stream: 'progress', emit: (e) => events.push(e) }), [{ role: 'user', content: 'x' }]);
    expect(events.some((e) => e.type === 'progress')).toBe(true);
    expect(events.some((e) => e.type === 'delta')).toBe(false);
  });
});

describe('toolSpec', () => {
  it('produces a JSON schema without $schema, with optional defaults', () => {
    const spec = toolSpec(defineTool({ name: 't', description: 'd', schema: z.object({ a: z.string(), b: z.array(z.string()).default([]) }), run: async () => 1 }));
    expect(spec.function.parameters).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { default: [], type: 'array', items: { type: 'string' } } }, required: ['a'] });
    expect(spec.function.parameters).not.toHaveProperty('$schema');
  });
});

describe('compactHistory', () => {
  const big = 'x'.repeat(8000);
  const history: ChatMessage[] = [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 't', arguments: {} } }] },
    { role: 'tool', content: big, tool_name: 't' },
    { role: 'assistant', content: big },
    ...Array.from({ length: 12 }, (_, i) => ({ role: 'user' as const, content: `recent ${i}` })),
  ];

  it('leaves small histories alone', () => {
    expect(compactHistory(history, 1_000_000)).toBe(history);
  });

  it('shrinks old bulky messages first, keeping recent ones intact', () => {
    const out = compactHistory(history, 2000);
    expect(out[2]!.content).toMatch(/older tool result removed/);
    expect(out[3]!.content.length).toBeLessThanOrEqual(2000);
    expect(out.slice(-12).map((m) => m.content)).toEqual(history.slice(-12).map((m) => m.content));
  });

  it('drops the oldest messages as a last resort without orphaning tool results', () => {
    const out = compactHistory(history, 50);
    expect(out[0]!.role).not.toBe('tool');
    expect(out).toHaveLength(12);
  });
});
