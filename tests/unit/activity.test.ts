import { describe, expect, it } from 'vitest';
import { applyEvent, emptyActivity, finalizeActivity, type ToolStep } from '../../src/shared/activity.js';
import type { AgentEvent } from '../../src/shared/events.js';

const ctx = { estimatedTokens: 100, window: 1000, percent: 10 };
const at = '2026-11-09T10:00:00.000Z';

describe('activity reducer', () => {
  it('builds a nested run tree with thoughts, text, tools and totals', () => {
    const events: AgentEvent[] = [
      { type: 'agent_start', runId: 'c', agent: 'coordinator', model: 'm', depth: 0, task: 'hi', systemPrompt: 'sys', tools: ['callWriter'], at },
      { type: 'llm_start', runId: 'c', step: 1, context: ctx, at },
      { type: 'thinking', runId: 'c', delta: 'Let me ' },
      { type: 'thinking', runId: 'c', delta: 'delegate.' },
      { type: 'llm_end', runId: 'c', step: 1, usage: { promptTokens: 90, evalTokens: 10 }, context: { ...ctx, promptTokens: 90 }, at },
      { type: 'tool_call', runId: 'c', callId: 't1', name: 'callWriter', args: { jobId: 'j' }, at },
      { type: 'agent_start', runId: 'w', agent: 'writer', model: 'm', parentRunId: 'c', parentCallId: 't1', depth: 1, task: 'write', systemPrompt: 's', tools: [], at },
      { type: 'skill_loaded', runId: 'w', skill: 'ats-cv-writing' },
      { type: 'agent_end', runId: 'w', status: 'done', output: 'done writing', at },
      { type: 'tool_result', runId: 'c', callId: 't1', name: 'callWriter', ok: true, result: 'done writing', ms: 42 },
      { type: 'llm_start', runId: 'c', step: 2, context: ctx, at },
      { type: 'text', runId: 'c', delta: 'All ' },
      { type: 'text', runId: 'c', delta: 'set!' },
      { type: 'llm_end', runId: 'c', step: 2, usage: { promptTokens: 120, evalTokens: 5 }, context: ctx, at },
      { type: 'agent_end', runId: 'c', status: 'done', output: 'All set!', at },
    ];
    const a = emptyActivity();
    for (const e of events) applyEvent(a, e);

    expect(a.rootRunIds).toEqual(['c']);
    const c = a.runs.c;
    expect(c.status).toBe('done');
    expect(c.totals).toEqual({ promptTokens: 210, evalTokens: 15, llmCalls: 2, toolCalls: 1 });
    expect(c.steps.map((s) => s.kind)).toEqual(['llm', 'tool', 'llm']);
    expect(c.steps[0]).toMatchObject({ thinking: 'Let me delegate.', done: true });
    expect(c.steps[2]).toMatchObject({ text: 'All set!' });
    const tool = c.steps[1] as ToolStep;
    expect(tool).toMatchObject({ ok: true, ms: 42, childRunIds: ['w'] });
    expect(a.runs.w.steps).toEqual([{ kind: 'skill', name: 'ats-cv-writing' }]);
    expect(a.runs.w.depth).toBe(1);
  });

  it('ignores events for unknown runs and finalizes running ones', () => {
    const a = emptyActivity();
    applyEvent(a, { type: 'thinking', runId: 'nope', delta: 'x' });
    applyEvent(a, { type: 'agent_start', runId: 'r', agent: 'critic', model: 'm', depth: 0, task: '', systemPrompt: '', tools: [], at });
    applyEvent(a, { type: 'llm_start', runId: 'r', step: 1, context: ctx, at });
    finalizeActivity(a);
    expect(a.runs.r.status).toBe('aborted');
    expect(a.runs.r.endedAt).toBeDefined();
    expect(Object.keys(a.runs)).toEqual(['r']);
  });
});
