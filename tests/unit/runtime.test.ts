import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agents/events.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { Workspace } from '../../src/storage/workspace.js';
import { makeRuntime, tempDir } from '../support/fixtures.js';
import { journeyLlm } from '../support/journey.js';
import { call, say, ScriptedLLM, step } from '../support/scriptedLlm.js';

let dir: string;
let cleanup: () => Promise<void>;
let ws: Workspace;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  ws = new Workspace(dir);
});
afterEach(() => cleanup());

const COMMON = ['evalMath', 'webSearch', 'webFetch', 'loadSkill'];

describe('AgentRuntime tool sets (as specified)', () => {
  it('gives each agent exactly its tools', () => {
    const rt = makeRuntime(new ScriptedLLM({}), ws);
    const names = (agent: 'coordinator' | 'writer' | 'critic') => rt.tools(agent).map((t) => t.name).sort();
    expect(names('coordinator')).toEqual(
      ['readProfile', 'writeProfile', 'editProfile', 'readJob', 'writeJob', 'editJob', 'searchJobs', 'readCV', 'searchCVs', 'callWriter', 'callCritic', ...COMMON].sort(),
    );
    expect(names('writer')).toEqual(['readCV', 'writeCV', 'editCV', 'searchCVs', 'readProfile', 'callCritic', ...COMMON].sort());
    expect(names('critic')).toEqual(['readCV', 'readJob', 'searchCVs', 'searchJobs', ...COMMON].sort());
  });

  it('uses per-agent models and the configured or detected context window', async () => {
    const rt = makeRuntime(new ScriptedLLM({}, 131_072), ws);
    expect(rt.spec('writer').model).toBe('writer-model');
    expect(makeRuntime(new ScriptedLLM({}), ws, { think: 'low' }).spec('critic').think).toBe('low');
    expect(await rt.contextWindow('critic')).toBe(131_072);
    expect(await makeRuntime(new ScriptedLLM({}, null), ws).contextWindow('critic')).toBe(32_768);
    expect(await makeRuntime(new ScriptedLLM({}, 131_072), ws, { contextWindow: 4096 }).contextWindow('critic')).toBe(4096);
  });

  it('lists only each agent’s own skills in its system prompt, without their bodies', async () => {
    const llm = new ScriptedLLM({ coordinator: () => say('hi'), writer: () => say('w'), critic: () => say('c') });
    const rt = makeRuntime(llm, ws);
    for (const agent of ['coordinator', 'writer', 'critic'] as const) await rt.run(agent, [{ role: 'user', content: 'x' }], { emit: () => {} });
    const system = (agent: string) => llm.requests.find((r) => r.agent === agent)!.messages[0].content;
    expect(system('coordinator')).toContain('- evidence-interviewing:');
    expect(system('writer')).toContain('- achievement-bullets:');
    expect(system('critic')).toContain('- review-rubric:');
    expect(system('writer')).not.toContain('review-rubric');
    expect(system('critic')).not.toContain('Score out of 10 by weighting');
  });

  it('loads a skill into the history when the agent asks for it', async () => {
    const llm = new ScriptedLLM({
      critic: (req) => (step(req) === 0 ? call('loadSkill', { name: 'review-rubric' }) : say('7/10')),
    });
    const history: ChatMessage[] = [{ role: 'user', content: 'review' }];
    await makeRuntime(llm, ws).run('critic', history, { emit: () => {} });
    expect(history.find((m) => m.tool_name === 'loadSkill')!.content).toContain('Score out of 10 by weighting');
  });
});

describe('delegation', () => {
  it('coordinator → writer → critic, each subagent with a fresh history and report flowing back', async () => {
    const llm = journeyLlm();
    const rt = makeRuntime(llm, ws);
    const events: AgentEvent[] = [];
    const history: ChatMessage[] = [{ role: 'user', content: 'I am Ada; CV for Acme please' }];
    const result = await rt.run('coordinator', history, { emit: (e) => events.push(e) });

    expect(result.text).toContain('ready in the preview panel');
    // writer got a brief with ids and the job record, but not the user's conversation
    const writerFirst = llm.requestsFor('writer')[0];
    const brief = writerFirst.messages[1].content;
    expect(writerFirst.messages).toHaveLength(2);
    expect(brief).toContain('Write a one-page CV');
    expect(brief).toMatch(/Job id: job-senior-typescript-engineer-acme-/);
    expect(brief).toContain('"company": "Acme"');
    expect(brief).not.toContain('I am Ada');
    // critic was called by the writer at depth 2
    const criticBrief = llm.requestsFor('critic')[0].messages[1].content;
    expect(criticBrief).toContain('Critique request from the writer');
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent_start', agent: 'writer', depth: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent_start', agent: 'critic', depth: 2 }));
    expect(events).toContainEqual({ type: 'agent_end', agent: 'critic', depth: 2, ok: true });
    // reports flow back up as tool results
    const writerHistory = llm.requestsFor('writer').at(-1)!.messages;
    expect(writerHistory.find((m) => m.tool_name === 'callCritic')!.content).toContain('CRITIC: 8/10');
    expect(history.find((m) => m.tool_name === 'callWriter')!.content).toContain('WRITER REPORT');
    // and the data landed
    const [job] = await ws.listJobs();
    expect((await ws.getCv(job.id)).preferences).toEqual({ tone: 'formal', pages: 1, emphasis: ['algorithms'] });
  });

  it('coordinator can call the critic directly', async () => {
    await ws.saveJob('j1', 'p1', { title: 'Dev' });
    await ws.saveCv('j1', { html: '<h1>Ada</h1>' });
    const llm = new ScriptedLLM({
      coordinator: (req) => (step(req) === 0 ? call('callCritic', { jobId: 'j1', focus: 'summary' }) : say('Critic says fine.')),
      critic: (req) => (step(req) === 0 ? call('readCV', { jobId: 'j1' }) : say('Looks fine: 7/10')),
    });
    const history: ChatMessage[] = [{ role: 'user', content: 'review it' }];
    await makeRuntime(llm, ws).run('coordinator', history, { emit: () => {} });
    expect(llm.requestsFor('critic')[0].messages[1].content).toContain('Critique request from the coordinator.\nJob id: j1\nFocus: summary');
    expect(history.find((m) => m.tool_name === 'callCritic')!.content).toContain('Looks fine: 7/10');
  });

  it('a failing subagent becomes an error the coordinator can handle', async () => {
    const llm = new ScriptedLLM({
      coordinator: (req) => (step(req) === 0 ? call('callWriter', { jobId: 'j9', instructions: 'go' }) : say('Sorry, the writer failed.')),
      writer: () => {
        throw new Error('model overloaded');
      },
    });
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const events: AgentEvent[] = [];
    const result = await makeRuntime(llm, ws).run('coordinator', history, { emit: (e) => events.push(e) });
    expect(history.find((m) => m.role === 'tool')!.content).toBe('Error: model overloaded');
    expect(events).toContainEqual({ type: 'agent_end', agent: 'writer', depth: 1, ok: false });
    expect(result.text).toBe('Sorry, the writer failed.');
  });
});
