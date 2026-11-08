import { describe, expect, it } from 'vitest';
import { buildTurns, latestCoordinatorContext, totals } from '../../src/client/activity.js';
import type { AgentEvent } from '../../src/agents/events.js';

const at = '2026-11-08T12:00:00Z';
const usage = { promptTokens: 100, completionTokens: 10 };

const events: AgentEvent[] = [
  { type: 'user_message', content: 'Write my CV', at },
  { type: 'run_start', runId: 'c1', agent: 'coordinator', model: 'm', task: 'Write my CV', at },
  { type: 'context', runId: 'c1', agent: 'coordinator', usedTokens: 1000, contextWindow: 10000, estimated: true, at },
  { type: 'llm_end', runId: 'c1', step: 0, content: '', thinking: 'plan', toolCalls: [{ id: 't1', name: 'callWriter' }], usage, durationMs: 5, at },
  { type: 'tool_start', runId: 'c1', callId: 't1', name: 'callWriter', args: { jobId: 'j' }, at },
  { type: 'run_start', runId: 'w1', parentRunId: 'c1', agent: 'writer', model: 'm', task: 'draft', at },
  { type: 'tool_start', runId: 'w1', callId: 't2', name: 'callCritic', args: {}, at },
  { type: 'run_start', runId: 'k1', parentRunId: 'w1', agent: 'critic', model: 'm', task: 'Review the CV.', at },
  { type: 'context', runId: 'k1', agent: 'critic', usedTokens: 500, contextWindow: 10000, estimated: false, at },
  { type: 'run_end', runId: 'k1', agent: 'critic', ok: true, result: 'Score: 8/10', steps: 1, usage, durationMs: 9, at },
  { type: 'tool_end', runId: 'w1', callId: 't2', name: 'callCritic', ok: true, result: '{}', durationMs: 9, at },
  { type: 'data_changed', entity: 'cv', jobId: 'j', at },
  { type: 'run_end', runId: 'w1', agent: 'writer', ok: true, result: 'Done', steps: 2, usage, durationMs: 20, at },
  { type: 'tool_end', runId: 'c1', callId: 't1', name: 'callWriter', ok: true, result: '{"report":"Done"}', durationMs: 20, at },
  { type: 'context', runId: 'c1', agent: 'coordinator', usedTokens: 1500, contextWindow: 10000, estimated: false, at },
  { type: 'run_end', runId: 'c1', agent: 'coordinator', ok: true, result: 'All set', steps: 2, usage, durationMs: 30, at },
];

describe('activity tree (UI)', () => {
  it('nests subagent runs under the tool call that started them', () => {
    const turns = buildTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe('Write my CV');
    const coordinator = turns[0].runs[0];
    expect(coordinator).toMatchObject({ agent: 'coordinator', status: 'ok', steps: 2 });
    const writerCall = coordinator.items.find((i) => i.kind === 'tool' && i.name === 'callWriter') as any;
    expect(writerCall.ok).toBe(true);
    const writer = writerCall.children[0];
    expect(writer.agent).toBe('writer');
    const critic = (writer.items[0] as any).children[0];
    expect(critic).toMatchObject({ agent: 'critic', result: 'Score: 8/10', context: { used: 500, estimated: false } });
    expect(turns[0].notes.map((n) => n.text)).toEqual(['CV updated']);
    expect(coordinator.items[0]).toMatchObject({ kind: 'llm', thinking: 'plan' });
  });

  it('reports coordinator context and totals', () => {
    expect(latestCoordinatorContext(events)).toEqual({ used: 1500, window: 10000, estimated: false });
    expect(totals(events)).toEqual({ promptTokens: 300, completionTokens: 30, runs: 3, tools: 2 });
  });

  it('marks running runs and errors', () => {
    const turns = buildTurns([
      { type: 'run_start', runId: 'x', agent: 'coordinator', model: 'm', task: 't', at },
      { type: 'error', runId: 'x', message: 'boom', at },
      { type: 'error', message: 'global', at },
    ]);
    expect(turns[0].runs[0].status).toBe('running');
    expect(turns[0].runs[0].items).toEqual([{ kind: 'note', level: 'error', text: 'boom' }]);
    expect(turns[0].notes[0].text).toBe('global');
  });
});
