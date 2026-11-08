import { afterEach, describe, expect, it } from 'vitest';
import { createTestEnv, createUser, type TestEnv } from '../helpers/env.js';
import { call, reply, ScriptedLlm } from '../helpers/scriptedLlm.js';
import type { AgentEvent } from '../../src/agents/events.js';
import { toolNames } from '../../src/agents/tools/index.js';
import type { ChatRequest } from '../../src/llm/types.js';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

/** Reads the jobId from the most recent editJob tool result in the conversation. */
const lastJobId = (req: ChatRequest) => {
  const tool = [...req.messages].reverse().find((m) => m.role === 'tool' && m.tool_name === 'editJob');
  return JSON.parse(tool!.content).jobId as string;
};

function fullPipeline() {
  return new ScriptedLlm(
    {
      coordinator: [
        call('editProfile', { operations: [{ op: 'set', path: 'name', value: 'Ann Example' }, { op: 'append', path: 'experience', value: { title: 'Engineer', company: 'Acme' } }] }),
        call('editJob', { job: { title: 'Platform Engineer', company: 'Globex', description: 'Kubernetes, Go' } }),
        (req) => call('callWriter', { jobId: lastJobId(req), instructions: 'Write a one-page CV' }),
        reply('Your CV is ready — have a look at the preview.'),
      ],
      writer: [
        call('loadSkill', { name: 'ats-cv-writing' }),
        call('readProfile', {}),
        call('editCV', { html: '<header class="cv-header"><h1>Ann Example</h1></header><section><h2>Experience</h2></section>' }),
        call('callCritic', {}),
        reply('Draft written. Critic score 8/10. Missing: dates for Acme.'),
      ],
      critic: [call('loadSkill', { name: 'cv-review-rubric' }), call('readCV', {}), reply('Score: 8/10 — solid.\n\nHigh\n- Add dates')],
    },
    { contextWindow: 50_000 },
  );
}

describe('coordinator → writer → critic orchestration', () => {
  it('runs the whole pipeline with nested runs, tools, data writes and system info', async () => {
    const llm = fullPipeline();
    env = await createTestEnv({ llm });
    const user = await createUser(env.repo);
    const events: AgentEvent[] = [];
    const res = await env.runtime.runCoordinator({
      userId: user.id,
      messages: [{ role: 'user', content: 'Please write my CV for the Globex role' }],
      task: 'Please write my CV',
      emit: (e) => events.push(e),
      timezone: 'Europe/London',
    });

    expect(res.ok).toBe(true);
    expect(res.final).toBe('Your CV is ready — have a look at the preview.');

    // Data landed in PostgreSQL through the tools.
    expect(await env.repo.getProfile(user.id)).toMatchObject({ name: 'Ann Example', experience: [{ company: 'Acme' }] });
    const [job] = await env.repo.listJobs(user.id);
    expect(job).toMatchObject({ title: 'Platform Engineer', company: 'Globex' });
    expect((await env.repo.getCv(user.id, job.id))?.html).toContain('<h1>Ann Example</h1>');

    // Run tree: coordinator → writer → critic.
    const starts = events.filter((e): e is Extract<AgentEvent, { type: 'run_start' }> => e.type === 'run_start');
    expect(starts.map((s) => s.agent)).toEqual(['coordinator', 'writer', 'critic']);
    expect(starts[0].parentRunId).toBeUndefined();
    expect(starts[1].parentRunId).toBe(starts[0].runId);
    expect(starts[2].parentRunId).toBe(starts[1].runId);
    const ends = events.filter((e) => e.type === 'run_end');
    expect(ends.map((e: any) => [e.agent, e.ok])).toEqual([
      ['critic', true],
      ['writer', true],
      ['coordinator', true],
    ]);

    // The writer's report is what the coordinator sees from callWriter.
    const writerResult = res.messages.find((m) => m.role === 'tool' && m.tool_name === 'callWriter')!;
    expect(JSON.parse(writerResult.content).report).toContain('Critic score 8/10');

    // Every agent sees datetime + context indicator and exactly its own tools.
    for (const agent of ['coordinator', 'writer', 'critic']) {
      const reqs = llm.requests.filter((r) => r.agent === agent);
      expect(reqs.length).toBeGreaterThan(0);
      for (const r of reqs) {
        expect(r.system).toContain('datetime: 2026-11-08T12:00:00.000Z');
        expect(r.system).toContain('Europe/London');
        expect(r.system).toMatch(/context_window: [\d,]+ \/ 50,000 tokens used/);
        expect(r.req.tools?.map((t) => t.function.name)).toEqual(toolNames(agent as any));
      }
    }
    const writerFirst = llm.requests.find((r) => r.agent === 'writer')!.req.messages[1].content;
    expect(writerFirst).toContain('Write a one-page CV');
    expect(writerFirst).toContain(job.id);
    expect(writerFirst).toContain('Platform Engineer at Globex');

    // Context events for every agent, estimated before calls and reported after.
    for (const agent of ['coordinator', 'writer', 'critic']) {
      const ctx = events.filter((e) => e.type === 'context' && e.agent === agent) as any[];
      expect(ctx.some((c) => c.estimated)).toBe(true);
      expect(ctx.some((c) => !c.estimated)).toBe(true);
      expect(ctx.every((c) => c.contextWindow === 50_000 && c.usedTokens > 0)).toBe(true);
    }
    expect(events.filter((e) => e.type === 'data_changed').map((e: any) => e.entity)).toEqual(['profile', 'job', 'cv']);
  });

  it('reports subagent failures to the coordinator instead of crashing the turn', async () => {
    const llm = new ScriptedLlm({
      coordinator: [
        call('editJob', { job: { title: 'Role' } }),
        (req) => call('callWriter', { jobId: lastJobId(req), instructions: 'Write it please' }),
        (req) => {
          const result = req.messages.at(-1)!;
          expect(result.content).toMatch(/^Error: Writer did not complete: The writer failed: model offline/);
          return reply('Sorry, the writer is unavailable right now.');
        },
      ],
      writer: [new Error('model offline')],
    });
    env = await createTestEnv({ llm });
    const user = await createUser(env.repo);
    const res = await env.runtime.runCoordinator({ userId: user.id, messages: [{ role: 'user', content: 'go' }], task: 'go', emit: () => {} });
    expect(res).toMatchObject({ ok: true, final: 'Sorry, the writer is unavailable right now.' });
  });

  it('resolves context windows from config, then the model, then the default', async () => {
    env = await createTestEnv({ llm: new ScriptedLlm({}, { contextWindow: 77_000 }), env: { CRITIC_CONTEXT_WINDOW: '9000' } });
    expect(await env.runtime.contextWindow('critic')).toBe(9000);
    expect(await env.runtime.contextWindow('writer')).toBe(77_000);
    await env.close();
    env = await createTestEnv({ llm: new ScriptedLlm() });
    expect(await env.runtime.contextWindow('coordinator')).toBe(32768);
  });

  it('builds each agent prompt with its own skills catalog', async () => {
    env = await createTestEnv();
    expect((await env.runtime.spec('coordinator')).systemPrompt).toContain('- cv-intake-interview:');
    expect((await env.runtime.spec('writer')).systemPrompt).toContain('- ats-cv-writing:');
    const critic = await env.runtime.spec('critic');
    expect(critic.systemPrompt).toContain('- cv-review-rubric:');
    expect(critic.systemPrompt).not.toContain('ats-cv-writing:');
  });
});
