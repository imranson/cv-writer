import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AbortError, runAgent, type AgentDeps } from '../../src/agents/runner.js';
import { SkillRegistry } from '../../src/agents/skills.js';
import type { Db } from '../../src/db/index.js';
import type { Repo } from '../../src/db/repo.js';
import { applyEvent, emptyActivity, type ToolStep } from '../../src/shared/activity.js';
import { call, calls, collector, createTestDb, say, ScriptedLlm, SKILLS_DIR } from '../helpers.js';

let db: Db;
let repo: Repo;
let userId: string;
let jobId: string;

function deps(llm: ScriptedLlm, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    llm,
    repo,
    skills: new SkillRegistry(SKILLS_DIR),
    config: { models: { coordinator: 'm-coord', writer: 'm-writer', critic: 'm-critic' }, maxSteps: { coordinator: 6, writer: 6, critic: 3 } },
    web: {},
    now: () => new Date('2026-11-09T09:30:00Z'),
    ...over,
  };
}

beforeAll(async () => {
  ({ db, repo } = await createTestDb());
  userId = (await repo.createUser({ email: 'ada@example.com', name: 'Ada', passwordHash: 'h' })).id;
  await repo.saveProfile(userId, { basics: { name: 'Ada Lovelace' }, experience: [{ company: 'Analytical Engines', title: 'Engineer' }] });
  jobId = (await repo.createJob(userId, { title: 'Data Engineer', company: 'Acme' })).id;
});
afterAll(() => db.close());

describe('coordinator → writer → critic orchestration', () => {
  it('runs the full delegation chain with nested activity and real data changes', async () => {
    const llm = new ScriptedLlm({
      coordinator: [
        { ...call('readProfile', {}), thinking: 'I should check the profile first.' },
        call('callWriter', { jobId, instructions: 'Write a one-page CV emphasising data engineering.' }),
        say('Your CV is ready — open the CV tab to preview or download it.', 'Summarise for the user.'),
      ],
      writer: [
        calls(['loadSkill', { name: 'ats-cv-writing' }], ['readJob', { jobId }]),
        call('editCV', { jobId, html: '<header><h1>Ada Lovelace</h1></header><section><h2>Experience</h2></section>' }),
        call('editCSS', { jobId, edits: [{ find: 'font-size: 22pt', replace: 'font-size: 20pt' }] }),
        call('callCritic', { jobId, focus: 'relevance' }),
        say('Draft written; critic scored 8/10.'),
      ],
      critic: [call('readCV', { jobId }), say('**Score: 8/10** — solid.')],
    });
    const { events, emit } = collector();
    const res = await runAgent(deps(llm), { agent: 'coordinator', userId, input: 'Write my CV for Acme', emit, signal: new AbortController().signal, focusJobId: jobId });

    expect(res.output).toBe('Your CV is ready — open the CV tab to preview or download it.');
    expect((await repo.getCv(userId, jobId)).html).toContain('<h1>Ada Lovelace</h1>');
    expect(await repo.getCss(userId, jobId)).toContain('font-size: 20pt');

    // Activity tree: coordinator → callWriter → writer → callCritic → critic
    const activity = emptyActivity();
    for (const e of events) applyEvent(activity, e);
    const coord = activity.runs[activity.rootRunIds[0]];
    expect(coord.agent).toBe('coordinator');
    const writerCall = coord.steps.find((s): s is ToolStep => s.kind === 'tool' && s.name === 'callWriter')!;
    expect(writerCall.result).toBe('Draft written; critic scored 8/10.');
    const writer = activity.runs[writerCall.childRunIds[0]];
    expect(writer).toMatchObject({ agent: 'writer', depth: 1, status: 'done', model: 'm-writer' });
    expect(writer.steps.some((s) => s.kind === 'skill' && s.name === 'ats-cv-writing')).toBe(true);
    const criticCall = writer.steps.find((s): s is ToolStep => s.kind === 'tool' && s.name === 'callCritic')!;
    const critic = activity.runs[criticCall.childRunIds[0]];
    expect(critic).toMatchObject({ agent: 'critic', depth: 2, output: '**Score: 8/10** — solid.' });
    expect(coord.steps[0]).toMatchObject({ kind: 'llm', thinking: 'I should check the profile first.' });

    // Data change notifications for the UI
    const changed = events.filter((e) => e.type === 'data_changed').map((e: any) => e.entity);
    expect(changed).toEqual(['cv', 'css']);
    // All runs finished
    expect(Object.values(activity.runs).every((r) => r.status === 'done')).toBe(true);
  });

  it('gives every agent the system information block (datetime + context indicator)', async () => {
    const llm = new ScriptedLlm({
      coordinator: [call('callCritic', { jobId }), say('done')],
      critic: [say('**Score: 7/10**')],
    });
    const { emit } = collector();
    await runAgent(deps(llm), { agent: 'coordinator', userId, input: 'review', emit, signal: new AbortController().signal, timeZone: 'Europe/London', extraInfo: () => ['Signed-in user: Ada'] });
    for (const { agent, req } of llm.requests) {
      const sys = req.messages[0].content;
      expect(sys, agent).toContain('# System information');
      expect(sys, agent).toContain('Monday, 9 November 2026 at 09:30 GMT');
      expect(sys, agent).toMatch(/Context window: ~[\d,]+ of 32,000 tokens used \([\d.]+%, estimated\)/);
    }
    expect(llm.requests[0].req.messages[0].content).toContain('Signed-in user: Ada');
    // Later calls in the same run also show the model-reported prompt size from the previous call
    const coordCalls = llm.requests.filter((r) => r.agent === 'coordinator');
    expect(coordCalls[0].req.messages[0].content).not.toContain('last model-reported');
    expect(coordCalls[1].req.messages[0].content).toContain('last model-reported prompt size: 100 tokens');
  });

  it('lists each agent’s own skills in its system prompt', async () => {
    const llm = new ScriptedLlm({ coordinator: [say('hi')] });
    await runAgent(deps(llm), { agent: 'coordinator', userId, input: 'hi', emit: () => {}, signal: new AbortController().signal });
    const sys = llm.requests[0].req.messages[0].content;
    expect(sys).toContain('- cv-intake-interview:');
    expect(sys).not.toContain('ats-cv-writing');
    expect(llm.requests[0].req.tools!.map((t) => t.function.name)).toContain('callWriter');
  });
});

describe('guard rails', () => {
  it('a subagent cannot use tools outside its set', async () => {
    const llm = new ScriptedLlm({
      coordinator: [call('callCritic', { jobId }), say('ok')],
      critic: [call('editCV', { jobId, html: '<p>hacked</p>' }), say('I cannot edit.')],
    });
    const before = (await repo.getCv(userId, jobId)).html;
    const { events, emit } = collector();
    await runAgent(deps(llm), { agent: 'coordinator', userId, input: 'x', emit, signal: new AbortController().signal });
    const result = events.find((e) => e.type === 'tool_result' && e.name === 'editCV') as any;
    expect(result.ok).toBe(false);
    expect(result.result).toMatch(/Unknown tool "editCV"/);
    expect((await repo.getCv(userId, jobId)).html).toBe(before);
    expect(llm.requests.find((r) => r.agent === 'critic')!.req.tools!.map((t) => t.function.name).sort()).toEqual(
      ['evalMath', 'loadSkill', 'readCV', 'readJob', 'readPreferences', 'webFetch', 'webSearch'],
    );
  });

  it('tool errors are returned to the model, which can recover', async () => {
    const llm = new ScriptedLlm({
      coordinator: [call('editProfile', {}), call('editProfile', { path: 'summary', value: 'Engineer' }), say('Saved.')],
    });
    const { events, emit } = collector();
    const res = await runAgent(deps(llm), { agent: 'coordinator', userId, input: 'x', emit, signal: new AbortController().signal });
    const results = events.filter((e) => e.type === 'tool_result') as any[];
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(results[0].result).toMatch(/^Error: Provide one of/);
    const toolMsg = llm.requests[1].req.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg).toMatchObject({ tool_name: 'editProfile', content: expect.stringMatching(/^Error:/) });
    expect(res.output).toBe('Saved.');
  });

  it('forces a final answer at the step limit', async () => {
    const llm = new ScriptedLlm({
      critic: [call('readJob', { jobId }), call('readJob', { jobId }), call('readJob', { jobId }), say('Final: 6/10')],
    });
    const res = await runAgent(deps(llm), { agent: 'critic', userId, input: 'review', emit: () => {}, signal: new AbortController().signal, focusJobId: jobId });
    expect(res.output).toBe('Final: 6/10');
    const last = llm.requests.at(-1)!.req;
    expect(last.tools).toBeUndefined();
    expect(last.messages.at(-1)!.content).toMatch(/Step limit reached/);
  });

  it('nudges after an empty reply', async () => {
    const llm = new ScriptedLlm({ coordinator: [say('', 'thinking only'), say('Hello!')] });
    const res = await runAgent(deps(llm), { agent: 'coordinator', userId, input: 'hi', emit: () => {}, signal: new AbortController().signal });
    expect(res.output).toBe('Hello!');
    expect(llm.requests[1].req.messages.at(-1)!.content).toMatch(/no visible text/);
  });

  it('recovers a subagent report from its reasoning after repeated empty replies', async () => {
    const llm = new ScriptedLlm({
      coordinator: [call('callCritic', { jobId }), say('ok')],
      critic: [say('', 'a'), say('', 'b'), say('', 'Score: 6/10 because of X')],
    });
    const { events, emit } = collector();
    await runAgent(deps(llm), { agent: 'coordinator', userId, input: 'x', emit, signal: new AbortController().signal });
    const result = events.find((e) => e.type === 'tool_result' && e.name === 'callCritic') as any;
    expect(result.result).toMatch(/recovered from the critic's reasoning\)\nScore: 6\/10 because of X/);
  });

  it('a failing subagent surfaces as a tool error, not a crash', async () => {
    const llm = new ScriptedLlm({ coordinator: [call('callWriter', { jobId, instructions: 'go' }), say('The writer failed; I will retry later.')], writer: [] });
    const { events, emit } = collector();
    const res = await runAgent(deps(llm), { agent: 'coordinator', userId, input: 'x', emit, signal: new AbortController().signal });
    const writerEnd = events.find((e) => e.type === 'agent_end' && e.status === 'error') as any;
    expect(writerEnd.error).toMatch(/no scripted response/);
    const result = events.find((e) => e.type === 'tool_result' && e.name === 'callWriter') as any;
    expect(result).toMatchObject({ ok: false });
    expect(result.result).toMatch(/writer subagent failed/);
    expect(res.output).toMatch(/retry later/);
  });

  it('can be aborted mid-run (including inside a subagent)', async () => {
    const ctrl = new AbortController();
    const llm = new ScriptedLlm({
      coordinator: [call('callWriter', { jobId, instructions: 'go' })],
      writer: [
        () => {
          ctrl.abort();
          return call('readJob', { jobId });
        },
      ],
    });
    const { events, emit } = collector();
    await expect(runAgent(deps(llm), { agent: 'coordinator', userId, input: 'x', emit, signal: ctrl.signal })).rejects.toBeInstanceOf(AbortError);
    const ends = events.filter((e) => e.type === 'agent_end') as any[];
    expect(ends.map((e) => [e.status])).toEqual([['aborted'], ['aborted']]);
  });

  it('carries prior history and reports per-call context estimates', async () => {
    const llm = new ScriptedLlm({ coordinator: [say('Welcome back.')] });
    const { events, emit } = collector();
    await runAgent(deps(llm), {
      agent: 'coordinator',
      userId,
      input: 'second message',
      history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }],
      emit,
      signal: new AbortController().signal,
    });
    expect(llm.requests[0].req.messages.slice(1).map((m) => m.content)).toEqual(['first', 'reply', 'second message']);
    const start = events.find((e) => e.type === 'llm_start') as any;
    expect(start.context.window).toBe(32000);
    expect(start.context.estimatedTokens).toBeGreaterThan(500);
    const end = events.find((e) => e.type === 'llm_end') as any;
    expect(end.context.promptTokens).toBe(100);
  });

  it('compacts old tool output when the context window fills up', async () => {
    const small = new ScriptedLlm({ coordinator: [say('ok')] }, 9000);
    const big = 'x'.repeat(12000);
    const history = Array.from({ length: 6 }, (_, i) => [
      { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: 'readCV', arguments: {} } }] },
      { role: 'tool' as const, content: `${i}${big}`, tool_name: 'readCV' },
    ]).flat();
    await runAgent(deps(small), { agent: 'coordinator', userId, input: 'x', history, emit: () => {}, signal: new AbortController().signal });
    const sent = small.requests[0].req.messages.filter((m) => m.role === 'tool');
    expect(sent[0].content).toMatch(/truncated to save context/);
    expect(sent.at(-1)!.content).toHaveLength(12001);
  });
});
