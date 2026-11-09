import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from '../../src/agents/skills.js';
import { evalMath, loadSkill, webFetch, webSearch } from '../../src/agents/tools/common.js';
import * as data from '../../src/agents/tools/data.js';
import { callCritic, callWriter } from '../../src/agents/tools/delegation.js';
import { executeTool, type ToolContext, type ToolDef } from '../../src/agents/tools/types.js';
import type { Db } from '../../src/db/index.js';
import type { Repo } from '../../src/db/repo.js';
import type { AgentEvent } from '../../src/shared/events.js';
import { createTestDb, SKILLS_DIR } from '../helpers.js';

let db: Db;
let repo: Repo;
let userId: string;
let otherId: string;
let jobId: string;
let events: AgentEvent[];

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    userId,
    agent: 'coordinator',
    runId: 'run-1',
    callId: 'call-1',
    repo,
    skills: new SkillRegistry(SKILLS_DIR),
    web: {},
    emit: (e) => void events.push(e),
    signal: new AbortController().signal,
    focusJobId: null,
    callAgent: async () => 'subagent report',
    ...over,
  };
}
const run = (tool: ToolDef, args: unknown, over?: Partial<ToolContext>) => executeTool(tool, args, ctx(over)) as Promise<any>;

beforeAll(async () => {
  ({ db, repo } = await createTestDb());
  userId = (await repo.createUser({ email: 'ada@example.com', name: 'Ada', passwordHash: 'h' })).id;
  otherId = (await repo.createUser({ email: 'eve@example.com', name: 'Eve', passwordHash: 'h' })).id;
});
afterAll(() => db.close());
beforeAll(() => {
  events = [];
});

describe('readProfile / editProfile', () => {
  it('editProfile WRITE replaces the document', async () => {
    const res = await run(data.editProfile, {
      profile: { basics: { name: 'Ada Lovelace', email: 'ada@example.com' }, experience: [{ company: 'Analytical Engines', title: 'Engineer', highlights: ['Wrote the first algorithm'] }], skills: ['Python'] },
    });
    expect(res).toMatchObject({ ok: true, mode: 'write', outline: { experience: 'array(1)' } });
    expect(events.at(-1)).toEqual({ type: 'data_changed', entity: 'profile' });
  });

  it('editProfile UPDATE via patch, path+value and deletePath', async () => {
    expect((await run(data.editProfile, { patch: { basics: { phone: '0700' }, summary: 'Mathematician' } })).mode).toBe('patch');
    expect((await run(data.editProfile, { path: 'skills[]', value: 'AWS' })).mode).toBe('set');
    expect((await run(data.editProfile, { path: 'experience[0].highlights[]', value: 'Built Python tooling' })).mode).toBe('set');
    expect((await run(data.editProfile, { deletePath: 'basics.phone' })).mode).toBe('delete');
    const profile = await repo.getProfile(userId);
    expect(profile).toMatchObject({ summary: 'Mathematician', skills: ['Python', 'AWS'] });
    expect(profile.basics.phone).toBeUndefined();
    expect(profile.experience[0].highlights).toHaveLength(2);
  });

  it('editProfile rejects ambiguous or empty edits', async () => {
    await expect(run(data.editProfile, {})).rejects.toThrow(/Provide one of/);
    await expect(run(data.editProfile, { patch: {}, path: 'a', value: 1 })).rejects.toThrow(/only one/);
    await expect(run(data.editProfile, { path: 'summary' })).rejects.toThrow(/value/);
    await expect(run(data.editProfile, { deletePath: 'nothing.here' })).rejects.toThrow(/Nothing at/);
    await expect(run(data.editProfile, { path: 'skills[9]', value: 'x' })).rejects.toThrow(/out of range/);
  });

  it('readProfile reads everything, one path, or searches', async () => {
    expect((await run(data.readProfile, {})).basics.name).toBe('Ada Lovelace');
    expect(await run(data.readProfile, { path: 'experience[0].company' })).toEqual({ path: 'experience[0].company', found: true, value: 'Analytical Engines' });
    expect((await run(data.readProfile, { path: 'nope' })).found).toBe(false);
    const search = await run(data.readProfile, { query: 'python' });
    expect(search.matches).toBe(2);
    expect(search.hits.map((h: any) => h.path)).toEqual(expect.arrayContaining(['skills[0]', 'experience[0].highlights[1]']));
  });
});

describe('readJob / editJob', () => {
  it('editJob without jobId creates a job (with CV, prefs, CSS)', async () => {
    const res = await run(data.editJob, { job: { title: 'Data Engineer', company: 'Acme', keywords: ['Python'] } });
    expect(res).toMatchObject({ ok: true, mode: 'create', job: { title: 'Data Engineer', status: 'draft' } });
    jobId = res.jobId;
    expect(events.at(-1)).toEqual({ type: 'data_changed', entity: 'jobs', jobId });
    expect((await repo.getCv(userId, jobId)).html).toBe('');
  });

  it('editJob updates an existing job', async () => {
    expect((await run(data.editJob, { jobId, patch: { location: 'London' } })).mode).toBe('patch');
    expect((await run(data.editJob, { jobId, path: 'requirements[]', value: '5+ years Python' })).mode).toBe('set');
    expect((await repo.getJob(userId, jobId)).data).toMatchObject({ location: 'London', requirements: ['5+ years Python'] });
    await expect(run(data.editJob, { jobId: 'missing', patch: {} })).rejects.toThrow(/not found/);
  });

  it('readJob lists jobs, reads one, reads a path and respects focus', async () => {
    const list = await run(data.readJob, {});
    expect(list).toEqual({ count: 1, jobs: [{ id: jobId, title: 'Data Engineer', company: 'Acme', status: 'draft', hasCv: false }] });
    expect((await run(data.readJob, { jobId })).company).toBe('Acme');
    expect((await run(data.readJob, { jobId, path: 'location' })).value).toBe('London');
    expect((await run(data.readJob, {}, { focusJobId: jobId })).jobId).toBe(jobId);
    expect((await run(data.readJob, { list: true }, { focusJobId: jobId })).count).toBe(1);
  });

  it('cannot reach another user’s job', async () => {
    await expect(run(data.readJob, { jobId }, { userId: otherId })).rejects.toThrow(/not found/);
    await expect(run(data.readCV, { jobId }, { userId: otherId })).rejects.toThrow(/not found/);
  });
});

describe('CV, CSS and preferences tools', () => {
  it('editCV writes full HTML (sanitized, body only) and applies find/replace edits', async () => {
    const res = await run(data.editCV, { jobId, html: '<html><body><h1 onclick="x()">Ada</h1><p>Python engineer</p><script>bad()</script></body></html>' }, { agent: 'writer' });
    expect(res).toMatchObject({ ok: true, mode: 'write', words: 3 });
    expect((await repo.getCv(userId, jobId)).html).toBe('<h1>Ada</h1><p>Python engineer</p>');
    expect(events.at(-1)).toEqual({ type: 'data_changed', entity: 'cv', jobId });
    await run(data.editCV, { jobId, edits: [{ find: 'Python engineer', replace: 'Senior Python engineer' }] });
    expect((await repo.getCv(userId, jobId)).html).toContain('Senior Python engineer');
    await expect(run(data.editCV, { jobId, edits: [{ find: 'missing', replace: 'x' }] })).rejects.toThrow(/not found/);
    await expect(run(data.editCV, { jobId })).rejects.toThrow(/exactly one/);
  });

  it('edits require a unique match unless all=true', async () => {
    await repo.saveCvHtml(userId, jobId, '<p>a</p><p>a</p>');
    await expect(run(data.editCV, { jobId, edits: [{ find: '<p>a</p>', replace: '<p>b</p>' }] })).rejects.toThrow(/occurs 2 times/);
    await run(data.editCV, { jobId, edits: [{ find: '<p>a</p>', replace: '<p>b</p>', all: true }] });
    expect((await repo.getCv(userId, jobId)).html).toBe('<p>b</p><p>b</p>');
  });

  it('readCV returns html, word and page counts (focus job by default)', async () => {
    const pageCount = vi.fn(async () => 2);
    const res = await run(data.readCV, {}, { focusJobId: jobId, pageCount });
    expect(res).toMatchObject({ jobId, empty: false, words: 2, pages: 2, html: '<p>b</p><p>b</p>' });
    expect(pageCount).toHaveBeenCalledWith(jobId);
    await expect(run(data.readCV, {})).rejects.toThrow(/No jobId/);
  });

  it('readCSS / editCSS', async () => {
    expect((await run(data.readCSS, { jobId })).css).toContain('@page');
    await run(data.editCSS, { jobId, css: 'body { font-size: 10pt; }' });
    await run(data.editCSS, { jobId, edits: [{ find: '10pt', replace: '10.5pt' }] });
    expect(await repo.getCss(userId, jobId)).toBe('body { font-size: 10.5pt; }');
    expect(events.at(-1)).toEqual({ type: 'data_changed', entity: 'css', jobId });
  });

  it('readPreferences / editPreferences with validation', async () => {
    expect(await run(data.readPreferences, { jobId })).toMatchObject({ jobId, pageSize: 'A4', maxPages: 2 });
    const res = await run(data.editPreferences, { jobId, patch: { maxPages: 1, tone: 'confident' } });
    expect(res.preferences).toMatchObject({ maxPages: 1, tone: 'confident', pageSize: 'A4' });
    await expect(run(data.editPreferences, { jobId, path: 'pageSize', value: 'A3' })).rejects.toThrow(/A4.*Letter/);
    expect(events.at(-1)).toMatchObject({ type: 'data_changed', entity: 'preferences' });
  });
});

describe('common tools', () => {
  it('evalMath', async () => {
    expect(await run(evalMath, { expression: '0.3*7 + 0.7*9' })).toEqual({ expression: '0.3*7 + 0.7*9', result: expect.closeTo(8.4, 10) });
    await expect(run(evalMath, { expression: '2 +' })).rejects.toThrow(/Cannot evaluate/);
  });

  it('webSearch and webFetch go through the injected fetch', async () => {
    const fetchImpl = vi.fn(async (url: any) =>
      String(url).includes('ollama.com/api/web_search')
        ? new Response(JSON.stringify({ results: [{ title: 'Acme careers', url: 'https://acme.com', content: 'Join us' }] }))
        : new Response('<title>Acme</title><p>We build rockets</p>', { headers: { 'content-type': 'text/html' } }),
    );
    const web = { apiKey: 'k', fetchImpl: fetchImpl as any, resolve: async () => ['93.184.216.34'] };
    expect((await run(webSearch, { query: 'acme' }, { web })).results[0].title).toBe('Acme careers');
    expect((await run(webFetch, { url: 'https://acme.com' }, { web })).content).toBe('We build rockets');
    await expect(run(webFetch, { url: 'http://localhost/admin' }, { web })).rejects.toThrow(/private/);
  });

  it('loadSkill loads only the calling agent’s skills and emits an event', async () => {
    const res = await run(loadSkill, { name: 'cv-intake-interview' });
    expect(res).toContain('# Skill: cv-intake-interview');
    expect(res).toContain('references/question-bank.md');
    expect(events.at(-1)).toEqual({ type: 'skill_loaded', runId: 'run-1', skill: 'cv-intake-interview' });
    const file = await run(loadSkill, { name: 'cv-intake-interview', file: 'references/question-bank.md' });
    expect(file).toContain('# Question bank');
    await expect(run(loadSkill, { name: 'cv-review-rubric' })).rejects.toThrow(/Unknown skill/);
    expect(await run(loadSkill, { name: 'cv-review-rubric' }, { agent: 'critic' })).toContain('Criteria and weights');
  });
});

describe('delegation tools', () => {
  it('callWriter / callCritic validate the job and delegate', async () => {
    const callAgent = vi.fn(async (agent: string) => `${agent} report`);
    expect(await run(callWriter, { jobId, instructions: 'Write it' }, { callAgent })).toBe('writer report');
    expect(callAgent).toHaveBeenLastCalledWith('writer', expect.stringContaining(`Job ID: ${jobId}`), { jobId, callId: 'call-1' });
    expect(await run(callCritic, {}, { callAgent, focusJobId: jobId, agent: 'writer' })).toBe('critic report');
    expect(callAgent.mock.calls.at(-1)![1]).toContain('Review request from the Writer');
    await expect(run(callWriter, { instructions: 'x' }, { callAgent })).rejects.toThrow(/jobId is required/);
    await expect(run(callWriter, { jobId: 'nope', instructions: 'x' }, { callAgent })).rejects.toThrow(/not found/);
    const empty = await repo.createJob(userId, {});
    await expect(run(callCritic, { jobId: empty.id }, { callAgent })).rejects.toThrow(/no CV yet/);
  });
});
