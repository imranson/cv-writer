import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, createUser, toolContext, type TestEnv } from '../helpers/env.js';
import { evalMath, loadSkill, webFetch, webSearch } from '../../src/agents/tools/common.js';
import {
  editCSS,
  editCV,
  editJob,
  editPreferences,
  editProfile,
  readCSS,
  readCV,
  readJob,
  readPreferences,
  readProfile,
} from '../../src/agents/tools/data.js';
import { callCritic, callWriter, MAX_CRITIQUES_PER_WRITER_RUN } from '../../src/agents/tools/delegation.js';
import type { Tool, ToolContext } from '../../src/agents/tool.js';
import { ToolError } from '../../src/agents/tool.js';

let env: TestEnv;
let userId: string;
let otherId: string;

/** Validates args with the tool's schema (as the loop does) and runs it. */
async function run<T = any>(tool: Tool, args: unknown, ctx: ToolContext): Promise<T> {
  return (await tool.run(tool.schema.parse(args), ctx)) as T;
}

beforeAll(async () => {
  env = await createTestEnv();
  userId = (await createUser(env.repo, 'tools@example.com', 'Tia Tools')).id;
  otherId = (await createUser(env.repo, 'other@example.com', 'Otto')).id;
});
afterAll(() => env.close());

describe('readProfile / editProfile', () => {
  it('writes the whole profile or updates paths, and reads/searches it', async () => {
    const { ctx, events } = toolContext(env, userId, 'coordinator');
    const write = await run(editProfile, { profile: { name: 'Tia', experience: [{ title: 'Dev', company: 'Acme', highlights: ['Python APIs'] }] } }, ctx);
    expect(write).toMatchObject({ ok: true, mode: 'write' });
    const update = await run(
      editProfile,
      { operations: [{ op: 'append', path: 'experience[0].highlights', value: 'Led AWS migration' }, { op: 'set', path: 'contact.email', value: 't@x.com' }] },
      ctx,
    );
    expect(update).toMatchObject({ mode: 'update', updatedPaths: ['append experience[0].highlights', 'set contact.email'] });
    expect(events.filter((e) => e.type === 'data_changed')).toHaveLength(2);

    expect(await run(readProfile, {}, ctx)).toMatchObject({ mode: 'read', profile: { contact: { email: 't@x.com' } } });
    expect(await run(readProfile, { path: 'experience[0].company' }, ctx)).toEqual({ mode: 'read', path: 'experience[0].company', value: 'Acme' });
    const search = await run(readProfile, { query: 'aws' }, ctx);
    expect(search).toMatchObject({ mode: 'search', count: 1, matches: [{ path: 'experience[0].highlights[1]', value: 'Led AWS migration' }] });
  });

  it('rejects empty edits and bad operations with model-readable errors', async () => {
    const { ctx } = toolContext(env, userId, 'coordinator');
    await expect(run(editProfile, {}, ctx)).rejects.toBeInstanceOf(ToolError);
    await expect(run(editProfile, { operations: [{ op: 'remove', path: 'nope.nothing' }] }, ctx)).rejects.toThrow('Could not apply operations');
  });

  it('notes an empty profile', async () => {
    const { ctx } = toolContext(env, otherId, 'writer');
    expect(await run(readProfile, {}, ctx)).toMatchObject({ profile: { name: 'Otto' } });
    await env.repo.saveProfile(otherId, {});
    expect(await run(readProfile, {}, ctx)).toMatchObject({ note: expect.stringContaining('empty') });
  });
});

describe('readJob / editJob', () => {
  it('creates, lists, reads, searches, writes and updates jobs', async () => {
    const { ctx, events } = toolContext(env, userId, 'coordinator');
    const created = await run(editJob, { job: { title: 'Data Engineer', company: 'Northwind', description: 'Python, Airflow, AWS' } }, ctx);
    expect(created).toMatchObject({ ok: true, mode: 'create', title: 'Data Engineer' });
    expect(events.at(-1)).toMatchObject({ type: 'data_changed', entity: 'job', jobId: created.jobId });

    const list = await run(readJob, {}, ctx);
    expect(list.mode).toBe('list');
    expect(list.jobs.map((j: any) => j.id)).toContain(created.jobId);

    expect(await run(readJob, { jobId: created.jobId }, ctx)).toMatchObject({ mode: 'read', job: { company: 'Northwind' }, cv: { empty: true } });
    expect(await run(readJob, { query: 'airflow' }, ctx)).toMatchObject({ mode: 'search', matches: [{ jobId: created.jobId, path: 'description' }] });
    expect(await run(readJob, { jobId: created.jobId, query: 'north' }, ctx)).toMatchObject({ matches: [{ path: 'company' }] });

    expect(await run(editJob, { jobId: created.jobId, operations: [{ op: 'set', path: 'location', value: 'Remote' }] }, ctx)).toMatchObject({ mode: 'update' });
    expect((await env.repo.getJob(userId, created.jobId))?.data.location).toBe('Remote');
    expect(await run(editJob, { jobId: created.jobId, job: { title: 'Senior Data Engineer', company: 'Northwind' } }, ctx)).toMatchObject({ mode: 'write' });
    expect((await env.repo.getJob(userId, created.jobId))?.data).toEqual({ title: 'Senior Data Engineer', company: 'Northwind' });
  });

  it('refuses unknown or foreign jobs and incomplete calls', async () => {
    const { ctx } = toolContext(env, userId, 'coordinator');
    const foreign = await env.repo.createJob(otherId, { title: 'Otto job' });
    await expect(run(readJob, { jobId: foreign.id }, ctx)).rejects.toThrow('No job found');
    await expect(run(editJob, { jobId: foreign.id, job: {} }, ctx)).rejects.toThrow('No job found');
    await expect(run(editJob, {}, ctx)).rejects.toThrow('To create a job');
    await expect(run(readJob, { jobId: 'garbage' }, ctx)).rejects.toThrow('No job found');
  });
});

describe('CV, CSS and preference tools', () => {
  it('writes and edits CV HTML (sanitised) and reports words and pages', async () => {
    const job = await env.repo.createJob(userId, { title: 'CV job' });
    const { ctx, events } = toolContext(env, userId, 'writer', { boundJobId: job.id });
    expect(await run(readCV, {}, ctx)).toMatchObject({ jobId: job.id, empty: true });

    const written = await run(editCV, { html: '<h1 onclick="x()">Tia Tools</h1><script>bad()</script><ul><li>Built APIs</li></ul>' }, ctx);
    expect(written).toMatchObject({ ok: true, mode: 'write', words: 4, pages: 1, maxPages: 2 });
    expect((await env.repo.getCv(userId, job.id))?.html).toBe('<h1>Tia Tools</h1><ul><li>Built APIs</li></ul>');

    expect(await run(editCV, { edits: [{ find: 'Built APIs', replace: 'Built 12 APIs' }] }, ctx)).toMatchObject({ mode: 'update' });
    await expect(run(editCV, { edits: [{ find: 'missing', replace: 'x' }] }, ctx)).rejects.toThrow('not found');
    expect(await run(readCV, { jobId: job.id }, ctx)).toMatchObject({ empty: false, words: 5, pages: 1, html: expect.stringContaining('12 APIs') });
    expect(events.filter((e) => e.type === 'data_changed' && e.entity === 'cv')).toHaveLength(2);
  });

  it('reads and edits raw CSS', async () => {
    const job = await env.repo.createJob(userId, { title: 'CSS job' });
    const { ctx } = toolContext(env, userId, 'writer', { boundJobId: job.id });
    expect((await run(readCSS, {}, ctx)).css).toContain('@page');
    expect(await run(editCSS, { css: 'body { font-size: 10pt; }' }, ctx)).toMatchObject({ mode: 'write' });
    expect(await run(editCSS, { edits: [{ find: '10pt', replace: '9.5pt' }] }, ctx)).toMatchObject({ mode: 'update' });
    expect((await run(readCSS, {}, ctx)).css).toBe('body { font-size: 9.5pt; }');
    await expect(run(editCSS, { css: '</style><script>x</script>' }, ctx)).rejects.toThrow('HTML tags');
  });

  it('reads, writes and updates per-CV preferences', async () => {
    const job = await env.repo.createJob(userId, { title: 'Prefs job' });
    const { ctx } = toolContext(env, userId, 'coordinator');
    expect((await run(readPreferences, { jobId: job.id }, ctx)).preferences).toMatchObject({ paperSize: 'A4', maxPages: 2 });
    expect(await run(editPreferences, { jobId: job.id, operations: [{ op: 'set', path: 'maxPages', value: 1 }, { op: 'append', path: 'emphasise', value: 'leadership' }] }, ctx)).toMatchObject({
      mode: 'update',
      preferences: { maxPages: 1, emphasise: ['leadership'] },
    });
    expect(await run(editPreferences, { jobId: job.id, preferences: { paperSize: 'Letter' } }, ctx)).toMatchObject({ mode: 'write', preferences: { paperSize: 'Letter' } });
  });

  it('requires a jobId for the coordinator and blocks other users', async () => {
    const { ctx } = toolContext(env, userId, 'coordinator');
    await expect(run(readCV, {}, ctx)).rejects.toThrow('jobId is required');
    const foreign = await env.repo.createJob(otherId, { title: 'x' });
    await expect(run(readCV, { jobId: foreign.id }, ctx)).rejects.toThrow('No job/CV found');
    await expect(run(readCSS, { jobId: foreign.id }, ctx)).rejects.toThrow('No job/CV found');
    await expect(run(readPreferences, { jobId: foreign.id }, ctx)).rejects.toThrow('No job/CV found');
  });
});

describe('delegation tools', () => {
  it('callWriter and callCritic run subagents with parent linkage', async () => {
    const job = await env.repo.createJob(userId, { title: 'Delegated' });
    const calls: any[] = [];
    const services = {
      ...env.runtime.services,
      runSubagent: async (agent: string, input: any) => {
        calls.push({ agent, ...input });
        return { ok: true, result: `${agent} report`, runId: `${agent}-run` };
      },
    };
    const { ctx } = toolContext(env, userId, 'coordinator', { services, runId: 'coord-run', timezone: 'Europe/London' });
    expect(await run(callWriter, { jobId: job.id, instructions: 'Write a first draft' }, ctx)).toEqual({ writerRunId: 'writer-run', report: 'writer report' });
    expect(await run(callCritic, { jobId: job.id, focus: 'keywords' }, ctx)).toEqual({ criticRunId: 'critic-run', critique: 'critic report' });
    expect(calls[0]).toMatchObject({ agent: 'writer', jobId: job.id, task: 'Write a first draft', parentRunId: 'coord-run', timezone: 'Europe/London' });
    expect(calls[1]).toMatchObject({ agent: 'critic', task: 'Review the CV. Focus requested by the coordinator: keywords' });
    await expect(run(callWriter, { jobId: 'nope', instructions: 'Write it' }, ctx)).rejects.toThrow('No job found');
  });

  it(`limits a writer run to ${MAX_CRITIQUES_PER_WRITER_RUN} critiques and surfaces subagent failures`, async () => {
    const job = await env.repo.createJob(userId, { title: 'Limited' });
    let ok = true;
    const services = { ...env.runtime.services, runSubagent: async () => ({ ok, result: ok ? 'fine' : 'crashed', runId: 'r' }) };
    const { ctx } = toolContext(env, userId, 'writer', { services, boundJobId: job.id });
    for (let i = 0; i < MAX_CRITIQUES_PER_WRITER_RUN; i++) await run(callCritic, {}, ctx);
    await expect(run(callCritic, {}, ctx)).rejects.toThrow('Critique limit reached');
    ok = false;
    const coordinator = toolContext(env, userId, 'coordinator', { services }).ctx;
    await expect(run(callCritic, { jobId: job.id }, coordinator)).rejects.toThrow('Critic did not complete: crashed');
  });
});

describe('common tools: evalMath, webSearch, webFetch, loadSkill', () => {
  it('evaluates maths for every agent', async () => {
    for (const agent of ['coordinator', 'writer', 'critic'] as const) {
      const { ctx } = toolContext(env, userId, agent);
      expect(await run(evalMath, { expression: '(2026-2017)*12' }, ctx)).toEqual({ expression: '(2026-2017)*12', result: 108 });
    }
    await expect(run(evalMath, { expression: '2+' }, toolContext(env, userId, 'critic').ctx)).rejects.toThrow('Could not evaluate');
  });

  it('searches and fetches through the web client', async () => {
    const { ctx } = toolContext(env, userId, 'writer');
    expect(await run(webSearch, { query: 'Northwind engineering culture', maxResults: 3 }, ctx)).toMatchObject({ results: [{ title: 'Result for Northwind engineering culture' }] });
    expect(await run(webFetch, { url: 'https://jobs.example/42' }, ctx)).toMatchObject({ title: 'Example job advert' });
    expect(env.web.searches).toContain('Northwind engineering culture');
    expect(env.web.fetches).toContain('https://jobs.example/42');
    expect(() => webFetch.schema.parse({ url: 'not a url' })).toThrow();
  });

  it('loads only the calling agent’s skills', async () => {
    expect(await run(loadSkill, { name: 'cv-review-rubric' }, toolContext(env, userId, 'critic').ctx)).toContain('# Skill: cv-review-rubric');
    expect(await run(loadSkill, { name: 'ats-cv-writing', file: 'references/cv-template.html' }, toolContext(env, userId, 'writer').ctx)).toContain('cv-entry');
    await expect(run(loadSkill, { name: 'ats-cv-writing' }, toolContext(env, userId, 'coordinator').ctx)).rejects.toThrow('Available skills: cv-intake-interview');
  });
});
