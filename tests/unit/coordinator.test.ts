import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createCoordinator, type CoordinatorToolDeps } from '../../src/agents/coordinator.js';
import type { WriterOutcome, WriterTask } from '../../src/agents/cvWriter.js';
import { renderMarkdown } from '../../src/cv/render.js';
import { verifyCv } from '../../src/cv/verify.js';
import type { CvDocument, CvVersion } from '../../src/domain/schemas.js';
import type { CvStore } from '../../src/storage/store.js';
import { sampleCv, sampleJob, seedProfile, tempStore } from '../helpers.js';
import { call, lastToolResult, say, ScriptedModel } from '../support/scripted.js';

async function setup(deps: Partial<CoordinatorToolDeps> = {}) {
  const store = await tempStore();
  const model = new ScriptedModel();
  const shown: CvVersion[] = [];
  const writerTasks: WriterTask[] = [];
  const coordinator = createCoordinator({
    store,
    client: model,
    model: 'coordinator-model',
    today: 'Sun Oct 04 2026',
    showCv: (cv) => shown.push(cv),
    writeCv: async (task) => {
      writerTasks.push(task);
      throw new Error('no writer in this test');
    },
    ...deps,
  });
  /** Has the scripted coordinator call one tool, returning what the tool sent back. */
  const invoke = async (name: string, args: Record<string, unknown> = {}) => {
    model.push(call(name, args), say('ok'));
    await coordinator.run(`please ${name}`);
    return lastToolResult(model.requests.at(-1)!);
  };
  return { store, model, coordinator, invoke, shown, writerTasks };
}

async function saveVersion(store: CvStore, jobId: string, doc: CvDocument = sampleCv()) {
  const profile = await store.getProfile();
  const job = await store.getJob(jobId);
  return store.saveCvVersion({
    jobId,
    profileRevision: profile.revision,
    changeSummary: 'draft',
    document: doc,
    markdown: renderMarkdown(doc),
    verification: verifyCv(doc, profile, job),
  });
}

describe('coordinator agent', () => {
  it('runs on its own model and prompt with exactly the coordinator tools', async () => {
    const { coordinator, model } = await setup({ fetchPage: async (url) => ({ url, text: '' }) });
    model.push(say('Hello'));
    await coordinator.run('hi');
    const [request] = model.requests;
    expect(request!.model).toBe('coordinator-model');
    expect(request!.messages[0]!.content).toMatch(/^You are the coordinator of a CV-writing service\./);
    expect(request!.tools!.map((t) => t.function.name)).toEqual([
      'get_profile',
      'update_contact',
      'set_headline',
      'upsert_profile_entry',
      'add_highlights',
      'remove_profile_entry',
      'add_skills',
      'add_facts',
      'save_job_listing',
      'list_job_listings',
      'get_job_listing',
      'write_cv',
      'list_cv_versions',
      'show_cv',
      'approve_cv',
      'fetch_job_posting',
    ]);
  });

  it('only offers fetch_job_posting when a fetcher is configured', async () => {
    const { coordinator, model } = await setup();
    model.push(say('Hello'));
    await coordinator.run('hi');
    expect(model.requests[0]!.tools!.map((t) => t.function.name)).not.toContain('fetch_job_posting');
  });

  it('cannot save CV versions itself', async () => {
    const { invoke, store } = await setup();
    const result = await invoke('save_cv_version', { jobId: 'x', document: sampleCv(), changeSummary: 's' });
    expect(result.content).toMatch(/no tool "save_cv_version" available to the coordinator/);
    expect(await store.readAudit()).toEqual([expect.objectContaining({ actor: 'coordinator', action: 'save_cv_version', ok: false })]);
  });
});

describe('profile tools', () => {
  it('get_profile reports completeness', async () => {
    const { invoke } = await setup();
    const { profile, completeness } = (await invoke('get_profile')).json();
    expect(profile.revision).toBe(0);
    expect(completeness.missing).toContain('full name');
  });

  it('update_contact, set_headline, add_skills and add_facts persist and are audited', async () => {
    const { invoke, store } = await setup();
    expect((await invoke('update_contact', { name: 'Sam', links: ['x.dev'] })).json()).toEqual({ name: 'Sam', links: ['x.dev'] });
    expect((await invoke('set_headline', { headline: 'Backend engineer' })).content).toBe('Saved.');
    expect((await invoke('add_skills', { category: 'Languages', items: ['Go'] })).json()).toEqual([{ category: 'Languages', items: ['Go'] }]);
    expect((await invoke('add_facts', { facts: ['Needs no visa'] })).json()).toEqual(['Needs no visa']);

    expect(await store.getProfile()).toMatchObject({ revision: 4, headline: 'Backend engineer', contact: { name: 'Sam' } });
    expect((await store.profileHistory()).map((h) => h.operation)).toEqual(['update_contact', 'set_headline', 'add_skills', 'add_facts']);
    expect((await store.readAudit()).map((e) => [e.actor, e.action, e.ok])).toEqual([
      ['coordinator', 'update_contact', true],
      ['coordinator', 'set_headline', true],
      ['coordinator', 'add_skills', true],
      ['coordinator', 'add_facts', true],
    ]);
  });

  it('upsert_profile_entry creates then updates, add_highlights appends, remove deletes', async () => {
    const { invoke, store } = await setup();
    const created = (await invoke('upsert_profile_entry', { section: 'experience', title: 'Intern', organisation: 'Acme' })).json();
    expect(created).toMatchObject({ created: true, entry: { id: 'experience-id1', title: 'Intern' } });

    const updated = (await invoke('upsert_profile_entry', { id: 'experience-id1', endDate: 'Present', summary: null })).json();
    expect(updated).toMatchObject({ created: false, entry: { organisation: 'Acme', endDate: 'Present' } });

    const withHighlights = (await invoke('add_highlights', { entryId: 'experience-id1', highlights: ['Cut costs 20%'] })).json();
    expect(withHighlights.highlights).toEqual(['Cut costs 20%']);

    expect((await invoke('remove_profile_entry', { entryId: 'experience-id1' })).content).toBe('Removed experience-id1.');
    expect((await store.getProfile()).entries).toEqual([]);
  });

  it('reports bad input as tool errors and leaves the profile unchanged', async () => {
    const { invoke, store } = await setup();
    expect((await invoke('upsert_profile_entry', { title: 'No section' })).content).toMatch(/upsert_profile_entry failed: section is required/);
    expect((await invoke('upsert_profile_entry', { section: 'job', title: 'X' })).content).toMatch(/invalid arguments for upsert_profile_entry/);
    expect((await invoke('add_highlights', { entryId: 'nope', highlights: ['x'] })).content).toMatch(/No profile entry with id "nope"/);
    expect((await store.readAudit()).every((e) => !e.ok)).toBe(true);
    expect((await store.getProfile()).revision).toBe(0);
  });
});

describe('job tools', () => {
  it('saves, lists and reads job listings', async () => {
    const { invoke } = await setup();
    const saved = (await invoke('save_job_listing', sampleJob())).json();
    expect(saved).toEqual({ jobId: 'acme-health-graduate-software-engineer-id1', title: 'Graduate Software Engineer', company: 'Acme Health' });
    expect((await invoke('list_job_listings')).json()).toEqual([expect.objectContaining({ jobId: saved.jobId, cvVersions: 0, approvedVersions: [] })]);
    expect((await invoke('get_job_listing', { jobId: saved.jobId })).json().keywords).toContain('AWS');
    expect((await invoke('get_job_listing', { jobId: 'missing' })).content).toMatch(/No job listing "missing"/);
    expect((await invoke('get_job_listing', { jobId: '../x' })).content).toMatch(/Invalid job id/);
  });

  it('fetches job postings through the configured fetcher', async () => {
    const { invoke } = await setup({ fetchPage: async (url) => ({ url, title: 'Engineer', text: 'We need Python.' }) });
    expect((await invoke('fetch_job_posting', { url: 'https://jobs.example/1' })).json()).toEqual({
      url: 'https://jobs.example/1',
      title: 'Engineer',
      text: 'We need Python.',
    });
  });
});

describe('CV tools', () => {
  async function withJob(deps: Partial<CoordinatorToolDeps> = {}) {
    const ctx = await setup(deps);
    await seedProfile(ctx.store);
    const job = await ctx.store.saveJob(sampleJob());
    return { ...ctx, jobId: job.id };
  }

  it('write_cv delegates to the writer, shows the result to the user and reports back', async () => {
    let version!: CvVersion;
    const ctx = await withJob({
      writeCv: async (task): Promise<WriterOutcome> => {
        version = await saveVersion(ctx.store, task.jobId);
        return { runId: 'run-1', version, savedVersions: [1], reply: 'Led with the internship. Any AWS numbers?' };
      },
    });
    const result = (await ctx.invoke('write_cv', { jobId: ctx.jobId, notes: 'one page' })).json();

    expect(ctx.shown).toEqual([version]);
    expect(result).toMatchObject({
      version: 1,
      shownToUser: true,
      verification: { passed: true, errors: [], warnings: [], keywordCoverage: { missing: ['Kubernetes'] } },
      writerNotes: 'Led with the internship. Any AWS numbers?',
      intermediateVersions: [],
      markdown: version.markdown,
    });
    expect(result.note).toMatch(/Do not repeat it/);
  });

  it('write_cv passes revision details through, coercing the version number', async () => {
    const tasks: WriterTask[] = [];
    const ctx = await withJob({
      writeCv: async (task) => {
        tasks.push(task);
        return { runId: 'r', savedVersions: [], reply: 'I could not do it' };
      },
    });
    const result = await ctx.invoke('write_cv', { jobId: ctx.jobId, basedOnVersion: '2', feedback: 'Shorter please' });
    expect(tasks).toEqual([{ jobId: ctx.jobId, basedOnVersion: 2, feedback: 'Shorter please' }]);
    expect(result.content).toBe('Error: write_cv failed: The CV writer did not save a CV. Its reply: I could not do it');
    expect(ctx.shown).toEqual([]);
  });

  it('write_cv reports writer failures as tool errors', async () => {
    const ctx = await withJob();
    expect((await ctx.invoke('write_cv', { jobId: ctx.jobId })).content).toBe('Error: write_cv failed: no writer in this test');
  });

  it('show_cv displays the stored version and list_cv_versions summarises them', async () => {
    const ctx = await withJob();
    const bad = sampleCv();
    bad.sections.push({ title: 'Awards', items: [], entries: [] });
    await saveVersion(ctx.store, ctx.jobId, bad);
    await saveVersion(ctx.store, ctx.jobId);

    const latest = (await ctx.invoke('show_cv', { jobId: ctx.jobId })).json();
    expect(latest).toMatchObject({ version: 2, shownToUser: true });
    const first = (await ctx.invoke('show_cv', { jobId: ctx.jobId, version: 1 })).json();
    expect(first.verification.errors).toEqual(['Section "Awards" has no content.']);
    expect(ctx.shown.map((v) => v.version)).toEqual([2, 1]);
    expect((await ctx.invoke('show_cv', { jobId: ctx.jobId, version: 9 })).content).toMatch(/No version 9/);

    const list = (await ctx.invoke('list_cv_versions', { jobId: ctx.jobId })).json();
    expect(list.map((v: any) => [v.version, v.verificationPassed, v.errors])).toEqual([
      [1, false, 1],
      [2, true, 0],
    ]);
  });

  it('approve_cv refuses versions with verification errors', async () => {
    const ctx = await withJob();
    const doc = sampleCv();
    doc.contactLine.push('[LinkedIn]');
    await saveVersion(ctx.store, ctx.jobId, doc);
    const result = await ctx.invoke('approve_cv', { jobId: ctx.jobId, version: 1 });
    expect(result.content).toMatch(/Version 1 has verification errors and cannot be approved:\n- Placeholder "\[LinkedIn\]"/);
    expect((await ctx.store.getCvVersion(ctx.jobId, 1))!.status).toBe('draft');
    expect((await ctx.invoke('approve_cv', { jobId: ctx.jobId, version: 5 })).content).toMatch(/No version 5/);
  });

  it('approve_cv exports the submission files and marks the version approved', async () => {
    const ctx = await withJob({ pdf: async (_html, out) => writeFile(out, '%PDF-stub') });
    await saveVersion(ctx.store, ctx.jobId);
    const result = (await ctx.invoke('approve_cv', { jobId: ctx.jobId, version: 1 })).json();
    expect(result).toMatchObject({ approved: true, warnings: [] });
    expect(result.files.pdf).toMatch(/output\/acme-health-graduate-software-engineer-id1\/alex-morgan-cv-v1\.pdf$/);
    expect(await readFile(result.files.markdown, 'utf8')).toBe(renderMarkdown(sampleCv()));
    expect(await ctx.store.getCvVersion(ctx.jobId, 1)).toMatchObject({ status: 'approved', exports: result.files });
    expect((await ctx.invoke('list_job_listings')).json()[0].approvedVersions).toEqual([1]);
  });
});
