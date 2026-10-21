import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_STEPS, runAgent } from '../../src/agents/runner';
import type { EmitInput } from '../../src/agents/types';
import { ScriptedLLM, makeDeps, tempDir } from '../helpers';

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeEach(async () => (tmp = await tempDir()));
afterEach(() => tmp.cleanup());

function collect() {
  const events: EmitInput[] = [];
  return { events, emit: (e: EmitInput) => events.push(e) };
}

describe('runAgent', () => {
  it('runs the tool loop until the model answers without tool calls', async () => {
    const llm = new ScriptedLLM({
      coordinator: [{ content: 'Let me check.', tools: [['evalMath', { expression: '6 * 7' }]] }, { content: 'The answer is 42.' }],
    });
    const { events, emit } = collect();
    const result = await runAgent({ deps: makeDeps(tmp.dir, llm), agent: 'coordinator', userId: 'u1', messages: [{ role: 'user', content: 'What is 6*7?' }], emit });

    expect(result.text).toBe('The answer is 42.');
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(result.messages[2]).toMatchObject({ role: 'tool', tool_name: 'evalMath' });
    expect(JSON.parse(result.messages[2].content).result).toBe(42);
    expect(events.map((e) => e.type)).toEqual([
      'agent_start',
      'delta',
      'delta',
      'usage',
      'assistant_message',
      'tool_call',
      'tool_result',
      'delta',
      'delta',
      'usage',
      'assistant_message',
      'agent_end',
    ]);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ name: 'evalMath', ok: true });
  });

  it('gives every agent a system prompt with datetime, context window and its skills', async () => {
    const llm = new ScriptedLLM();
    await runAgent({ deps: makeDeps(tmp.dir, llm), agent: 'critic', userId: 'u1', messages: [{ role: 'user', content: 'Review' }], emit: () => {} });
    const req = llm.requests[0].request;
    const system = req.messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/^You are the Critic/);
    expect(system.content).toContain('Current date and time: Wednesday, 21 October 2026');
    expect(system.content).toMatch(/Context window: [\d,]+ of 100,000 tokens used/);
    expect(system.content).toContain('cv-review-rubric');
    expect(req.model).toBe('test-critic');
    expect(req.tools.map((t) => t.function.name).sort()).toEqual(['evalMath', 'loadSkill', 'readCV', 'readJob', 'readPreferences', 'webFetch', 'webSearch']);
  });

  it('reports context usage from the model’s token counts', async () => {
    const { events, emit } = collect();
    const result = await runAgent({ deps: makeDeps(tmp.dir, new ScriptedLLM()), agent: 'writer', userId: 'u1', messages: [{ role: 'user', content: 'Hi' }], emit });
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ agent: 'writer', usage: { window: 100_000, estimated: false } });
    expect(result.usage.used).toBe(result.usage.promptTokens + result.usage.outputTokens);
  });

  it('runs nested subagents: coordinator → writer → critic', async () => {
    const deps = makeDeps(tmp.dir);
    const job = await deps.store.createJob('u1', { title: 'Engineer', company: 'Acme' });
    deps.llm = new ScriptedLLM({
      coordinator: [{ tools: [['callWriter', { jobId: job.id, instructions: 'Draft it' }]] }, { content: 'Your CV is ready.' }],
      writer: [
        { tools: [['editCV', { jobId: job.id, html: '<h1>Ada</h1>' }]] },
        { tools: [['callCritic', { jobId: job.id }]] },
        { content: 'Drafted; critic scored 8/10.' },
      ],
      critic: [{ tools: [['readCV', { jobId: job.id }]] }, { content: 'Score: 8/10' }],
    });
    const { events, emit } = collect();
    const result = await runAgent({ deps, agent: 'coordinator', userId: 'u1', messages: [{ role: 'user', content: 'Write my CV' }], emit });

    expect(result.text).toBe('Your CV is ready.');
    const starts = events.filter((e) => e.type === 'agent_start');
    expect(starts.map((e) => e.agent)).toEqual(['coordinator', 'writer', 'critic']);
    expect(starts[1].parentRunId).toBe(starts[0].runId);
    expect(starts[2].parentRunId).toBe(starts[1].runId);
    expect(await deps.store.getCv('u1', job.id)).toBe('<h1>Ada</h1>');
    const writerResult = JSON.parse(result.messages[2].content);
    expect(writerResult).toMatchObject({ agent: 'writer', report: 'Drafted; critic scored 8/10.' });
    expect(new Set(events.filter((e) => e.type === 'usage').map((e) => e.agent))).toEqual(new Set(['coordinator', 'writer', 'critic']));
  });

  it('stops after the step limit', async () => {
    const llm = new ScriptedLLM({ critic: Array(MAX_STEPS.critic + 2).fill({ tools: [['evalMath', { expression: '1' }]] }) });
    const result = await runAgent({ deps: makeDeps(tmp.dir, llm), agent: 'critic', userId: 'u1', messages: [{ role: 'user', content: 'loop' }], emit: () => {} });
    expect(llm.requests).toHaveLength(MAX_STEPS.critic);
    expect(result.text).toMatch(/Stopped after 12 steps/);
  });

  it('aborts and returns partial history on the error', async () => {
    const controller = new AbortController();
    const llm = new ScriptedLLM({
      coordinator: [
        () => {
          controller.abort();
          return { tools: [['evalMath', { expression: '1+1' }]] };
        },
      ],
    });
    const { events, emit } = collect();
    const err: any = await runAgent({
      deps: makeDeps(tmp.dir, llm),
      agent: 'coordinator',
      userId: 'u1',
      messages: [{ role: 'user', content: 'go' }],
      emit,
      signal: controller.signal,
    }).catch((e) => e);
    expect(err.message).toBe('Aborted');
    expect(err.partialMessages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', error: 'Aborted' });
  });

  it('compacts history that approaches the context window', async () => {
    const llm = new ScriptedLLM({}, 3_000);
    const history = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'readCV', arguments: {} } }] },
      { role: 'tool', content: 'x'.repeat(12_000), tool_name: 'readCV' },
      { role: 'assistant', content: 'ok' },
      ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })),
    ];
    await runAgent({ deps: makeDeps(tmp.dir, llm), agent: 'critic', userId: 'u1', messages: history, emit: () => {} });
    const sent = llm.requests[0].request.messages;
    expect(sent.some((m) => m.content.length >= 12_000)).toBe(false);
  });
});
