import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent, type AgentSpec } from '../../src/agents/loop.js';
import { defineTool, ToolError, type AgentServices } from '../../src/agents/tool.js';
import type { AgentEvent } from '../../src/agents/events.js';
import { call, reply, ScriptedLlm } from '../helpers/scriptedLlm.js';

const echo = defineTool({
  name: 'echo',
  description: 'Echo text',
  schema: z.object({ text: z.string() }),
  run: async ({ text }) => ({ echoed: text }),
});
const failing = defineTool({
  name: 'failing',
  description: 'Always fails',
  schema: z.object({}),
  run: async () => {
    throw new ToolError('nope');
  },
});

function setup(llm: ScriptedLlm, overrides: Partial<AgentSpec> = {}) {
  const events: AgentEvent[] = [];
  const spec: AgentSpec = { agent: 'critic', model: 'test-model', systemPrompt: 'You are a test.', tools: [echo, failing], maxSteps: 5, contextWindow: 10_000, ...overrides };
  const services = { llm, now: () => new Date('2026-11-08T12:00:00Z') } as unknown as AgentServices;
  return { events, spec, services };
}

describe('agent loop', () => {
  it('runs tools until the model answers and emits the full activity trail', async () => {
    const llm = new ScriptedLlm({ critic: [call('echo', { text: 'hi' }), reply('Final answer')] });
    const { events, spec, services } = setup(llm);
    const res = await runAgent({ spec, messages: [{ role: 'user', content: 'go' }], task: 'go', userId: 'u', services, emit: (e) => events.push(e) });

    expect(res).toMatchObject({ ok: true, final: 'Final answer', steps: 2 });
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(res.messages[2]).toMatchObject({ role: 'tool', tool_name: 'echo', content: '{"echoed":"hi"}' });
    expect(res.messages[2].tool_call_id).toBe(res.messages[1].tool_calls![0].id);

    const types = events.map((e) => e.type).filter((t) => t !== 'text_delta');
    expect(types).toEqual(['run_start', 'context', 'llm_start', 'context', 'llm_end', 'tool_start', 'tool_end', 'context', 'llm_start', 'context', 'llm_end', 'run_end']);
    expect(events.filter((e) => e.type === 'text_delta').map((e: any) => e.delta).join('')).toBe('Final answer');
    const ctx = events.filter((e): e is Extract<AgentEvent, { type: 'context' }> => e.type === 'context');
    expect(ctx[0]).toMatchObject({ agent: 'critic', contextWindow: 10_000, estimated: true });
    expect(ctx[1].estimated).toBe(false);
  });

  it('gives the model datetime and context information on every call', async () => {
    const llm = new ScriptedLlm({ critic: [call('echo', { text: 'x' }), reply('done')] });
    const { spec, services } = setup(llm);
    await runAgent({ spec, messages: [{ role: 'user', content: 'go' }], task: 'go', userId: 'u', services, emit: () => {}, timezone: 'UTC' });
    for (const r of llm.requests) {
      expect(r.system).toContain('You are a test.');
      expect(r.system).toContain('datetime: 2026-11-08T12:00:00.000Z');
      expect(r.system).toMatch(/context_window: [\d,]+ \/ 10,000 tokens used/);
      expect(r.req.tools?.map((t) => t.function.name)).toEqual(['echo', 'failing']);
    }
  });

  it('reports tool errors, invalid arguments and unknown tools back to the model', async () => {
    const llm = new ScriptedLlm({
      critic: [
        { toolCalls: [{ name: 'failing', args: {} }, { name: 'echo', args: { text: 5 } }, { name: 'ghost', args: {} }] },
        reply('recovered'),
      ],
    });
    const { events, spec, services } = setup(llm);
    const res = await runAgent({ spec, messages: [{ role: 'user', content: 'go' }], task: 'go', userId: 'u', services, emit: (e) => events.push(e) });
    const results = res.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(results[0]).toBe('Error: nope');
    expect(results[1]).toMatch(/invalid arguments for echo: text:/);
    expect(results[2]).toMatch(/unknown tool "ghost"/);
    expect(events.filter((e) => e.type === 'tool_end').every((e: any) => e.ok === false)).toBe(true);
    expect(res.ok).toBe(true);
  });

  it('forces a final answer without tools on the last step', async () => {
    const llm = new ScriptedLlm({ critic: [call('echo', { text: '1' }), call('echo', { text: '2' }), { content: 'summary', toolCalls: [{ name: 'echo', args: { text: '3' } }] }] });
    const { spec, services } = setup(llm, { maxSteps: 3 });
    const res = await runAgent({ spec, messages: [{ role: 'user', content: 'go' }], task: 'go', userId: 'u', services, emit: () => {} });
    expect(res).toMatchObject({ ok: true, final: 'summary', steps: 3 });
    expect(llm.requests[2].req.tools).toBeUndefined();
    expect(llm.requests[2].system).toContain('STEP LIMIT REACHED');
  });

  it('turns model failures into a failed run instead of throwing', async () => {
    const llm = new ScriptedLlm({ critic: [new Error('Ollama exploded')] });
    const { events, spec, services } = setup(llm);
    const res = await runAgent({ spec, messages: [{ role: 'user', content: 'go' }], task: 'go', userId: 'u', services, emit: (e) => events.push(e) });
    expect(res.ok).toBe(false);
    expect(res.final).toContain('Ollama exploded');
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run_end', ok: false });
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const llm = new ScriptedLlm({ critic: [reply('never')] }, { delayMs: 200 });
    const { spec, services } = setup(llm);
    setTimeout(() => controller.abort(new Error('stop')), 20);
    const res = await runAgent({ spec, messages: [{ role: 'user', content: 'go' }], task: 'go', userId: 'u', services, emit: () => {}, signal: controller.signal });
    expect(res).toMatchObject({ ok: false, aborted: true, final: 'Stopped by user.' });
  });

  it('compacts old tool output when the context window fills up', async () => {
    const big = 'z'.repeat(14_000);
    const llm = new ScriptedLlm({ critic: [reply('ok')] });
    const { events, spec, services } = setup(llm, { contextWindow: 3000 });
    const history = [
      { role: 'user' as const, content: 'q' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'a', function: { name: 'echo', arguments: {} } }] },
      { role: 'tool' as const, content: big, tool_name: 'echo' },
      ...Array.from({ length: 6 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}` })),
    ];
    await runAgent({ spec, messages: history, task: 'go', userId: 'u', services, emit: (e) => events.push(e) });
    const sent = llm.requests[0].req.messages.find((m) => m.role === 'tool')!;
    expect(sent.content).toMatch(/older tool result removed/);
    const firstCtx = events.find((e) => e.type === 'context') as any;
    expect(firstCtx.usedTokens).toBeLessThan(3000);
  });
});
