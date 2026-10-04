import { describe, expect, it } from 'vitest';
import { createCvTools, mcpToolName } from '../../src/agents/tools.js';
import type { CvStore } from '../../src/storage/store.js';
import { resultJson, resultText, sampleCv, sampleJob, sampleProfile, tempStore } from '../helpers.js';

async function setup(deps = {}) {
  const store = await tempStore();
  const tools = createCvTools(store, deps);
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((t) => t.definition.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.definition.handler(args, {});
  };
  return { store, tools, call };
}

async function seedProfile(store: CvStore) {
  const { revision, updatedAt, ...rest } = sampleProfile();
  await store.updateProfile('seed', {}, (p) => ({ ...p, ...rest }));
}

describe('tool catalogue', () => {
  it('assigns every tool an owner', async () => {
    const { tools } = await setup();
    const byOwner = (o: string) => tools.filter((t) => t.owner === o).map((t) => t.definition.name).sort();
    expect(byOwner('cv-writer')).toEqual(['save_cv_version']);
    expect(byOwner('shared')).toEqual(['get_cv_version', 'get_job_listing', 'get_profile', 'list_cv_versions', 'list_job_listings']);
    expect(byOwner('coordinator')).toHaveLength(9);
    expect(mcpToolName('get_profile')).toBe('mcp__cv__get_profile');
  });
});

describe('profile tools', () => {
  it('get_profile reports completeness', async () => {
    const { call } = await setup();
    const { profile, completeness } = resultJson(await call('get_profile'));
    expect(profile.revision).toBe(0);
    expect(completeness.missing).toContain('full name');
  });

  it('update_contact, set_headline, add_skills and add_facts persist and are audited', async () => {
    const { call, store } = await setup();
    expect(resultJson(await call('update_contact', { name: 'Sam', links: ['x.dev'] }))).toEqual({ name: 'Sam', links: ['x.dev'] });
    expect(resultText(await call('set_headline', { headline: 'Backend engineer' }))).toBe('Saved.');
    expect(resultJson(await call('add_skills', { category: 'Languages', items: ['Go'] }))).toEqual([
      { category: 'Languages', items: ['Go'] },
    ]);
    expect(resultJson(await call('add_facts', { facts: ['Needs no visa'] }))).toEqual(['Needs no visa']);

    const profile = await store.getProfile();
    expect(profile).toMatchObject({ revision: 4, headline: 'Backend engineer', contact: { name: 'Sam' } });
    expect((await store.readAudit()).map((e) => [e.actor, e.action, e.ok])).toEqual([
      ['coordinator', 'update_contact', true],
      ['coordinator', 'set_headline', true],
      ['coordinator', 'add_skills', true],
      ['coordinator', 'add_facts', true],
    ]);
  });

  it('upsert_profile_entry creates then updates, add_highlights appends, remove deletes', async () => {
    const { call, store } = await setup();
    const created = resultJson(await call('upsert_profile_entry', { section: 'experience', title: 'Intern', organisation: 'Acme' }));
    expect(created).toMatchObject({ created: true, entry: { id: 'experience-id1', title: 'Intern' } });

    const updated = resultJson(await call('upsert_profile_entry', { id: 'experience-id1', endDate: 'Present' }));
    expect(updated).toMatchObject({ created: false, entry: { organisation: 'Acme', endDate: 'Present' } });

    const withHighlights = resultJson(await call('add_highlights', { entryId: 'experience-id1', highlights: ['Cut costs 20%'] }));
    expect(withHighlights.highlights).toEqual(['Cut costs 20%']);

    expect(resultText(await call('remove_profile_entry', { entryId: 'experience-id1' }))).toBe('Removed experience-id1.');
    expect((await store.getProfile()).entries).toEqual([]);
  });

  it('returns tool errors (not exceptions) for bad input, and audits them', async () => {
    const { call, store } = await setup();
    const result = await call('upsert_profile_entry', { title: 'No section' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/upsert_profile_entry failed: section is required/);
    expect((await call('add_highlights', { entryId: 'nope', highlights: ['x'] })).isError).toBe(true);
    expect((await store.readAudit()).every((e) => !e.ok)).toBe(true);
    expect((await store.getProfile()).revision).toBe(0);
  });
});

describe('job tools', () => {
  it('saves, lists and reads job listings', async () => {
    const { call } = await setup();
    const saved = resultJson(await call('save_job_listing', sampleJob()));
    expect(saved).toEqual({ jobId: 'acme-health-graduate-software-engineer-id1', title: 'Graduate Software Engineer', company: 'Acme Health' });
    expect(resultJson(await call('list_job_listings'))).toEqual([
      expect.objectContaining({ jobId: saved.jobId, cvVersions: 0, approvedVersions: [] }),
    ]);
    expect(resultJson(await call('get_job_listing', { jobId: saved.jobId })).keywords).toContain('AWS');
    expect((await call('get_job_listing', { jobId: 'missing' })).isError).toBe(true);
    expect((await call('get_job_listing', { jobId: '../x' })).isError).toBe(true);
  });
});

describe('CV tools', () => {
  async function withJob(deps = {}) {
    const ctx = await setup(deps);
    await seedProfile(ctx.store);
    const { jobId } = resultJson(await ctx.call('save_job_listing', sampleJob()));
    return { ...ctx, jobId: jobId as string };
  }

  it('save_cv_version renders, verifies and stores against the current profile revision', async () => {
    const { call, store, jobId } = await withJob();
    const result = resultJson(await call('save_cv_version', { jobId, document: sampleCv(), changeSummary: 'v1' }));
    expect(result).toMatchObject({ version: 1, verificationPassed: true, issues: [] });
    expect(result.keywordCoverage.missing).toEqual(['Kubernetes']);

    const stored = await store.getCvVersion(jobId, 1);
    expect(stored).toMatchObject({ profileRevision: 1, status: 'draft', changeSummary: 'v1' });
    expect(stored!.markdown).toMatch(/^# Alex Morgan/);
  });

  it('save_cv_version applies schema defaults and reports verification errors', async () => {
    const { call, jobId } = await withJob();
    const doc = { name: 'Alex Morgan', contactLine: ['[City]'], sections: [{ title: 'Experience', entries: [{ heading: 'Research Intern', sourceIds: ['bogus'] }] }] };
    const result = resultJson(await call('save_cv_version', { jobId, document: doc, changeSummary: 'bad' }));
    expect(result.verificationPassed).toBe(false);
    expect(result.issues.map((i: { code: string }) => i.code)).toEqual(
      expect.arrayContaining(['unknown-source', 'placeholder', 'missing-email']),
    );
  });

  it('save_cv_version rejects unknown jobs and base versions', async () => {
    const { call, jobId } = await withJob();
    expect(resultText(await call('save_cv_version', { jobId: 'nope', document: sampleCv(), changeSummary: 'x' }))).toMatch(/No job listing/);
    expect(
      resultText(await call('save_cv_version', { jobId, document: sampleCv(), changeSummary: 'x', basedOnVersion: 4 })),
    ).toMatch(/basedOnVersion 4 does not exist/);
  });

  it('get_cv_version returns Markdown by default and the document when structured', async () => {
    const { call, jobId } = await withJob();
    await call('save_cv_version', { jobId, document: sampleCv(), changeSummary: 'v1' });
    await call('save_cv_version', { jobId, document: sampleCv(), changeSummary: 'v2', basedOnVersion: 1, feedback: 'tighter' });

    const latest = resultText(await call('get_cv_version', { jobId }));
    expect(latest).toContain('"version": 2');
    expect(latest).toContain('"feedback": "tighter"');
    expect(latest).toContain('----- CV (Markdown) -----\n\n# Alex Morgan');

    const structured = resultJson(await call('get_cv_version', { jobId, version: 1, format: 'structured' }));
    expect(structured.document).toEqual(sampleCv());
    expect((await call('get_cv_version', { jobId, version: 9 })).isError).toBe(true);

    expect(resultJson(await call('list_cv_versions', { jobId })).map((v: { version: number; basedOnVersion?: number }) => [v.version, v.basedOnVersion])).toEqual([
      [1, undefined],
      [2, 1],
    ]);
  });

  it('get_cv_version explains when there are no drafts yet', async () => {
    const { call, jobId } = await withJob();
    expect(resultText(await call('get_cv_version', { jobId }))).toMatch(/No CV versions for job/);
  });

  it('approve_cv exports files and marks the version approved', async () => {
    const pdfs: string[] = [];
    const { call, store, jobId } = await withJob({ pdf: async (_html: string, pdf: string) => void pdfs.push(pdf) });
    await call('save_cv_version', { jobId, document: sampleCv(), changeSummary: 'v1' });

    const result = resultJson(await call('approve_cv', { jobId, version: 1 }));
    expect(result.approved).toBe(true);
    expect(result.files.markdown).toBe(`${store.outputDir}/${jobId}/alex-morgan-cv-v1.md`);
    expect(pdfs).toEqual([`${store.outputDir}/${jobId}/alex-morgan-cv-v1.pdf`]);
    expect(await store.getCvVersion(jobId, 1)).toMatchObject({ status: 'approved', exports: result.files });
    expect(resultJson(await call('list_job_listings'))[0].approvedVersions).toEqual([1]);
  });

  it('approve_cv refuses versions with verification errors', async () => {
    const { call, store, jobId } = await withJob();
    const doc = sampleCv();
    doc.contactLine.push('[Phone]');
    await call('save_cv_version', { jobId, document: doc, changeSummary: 'v1' });
    const result = await call('approve_cv', { jobId, version: 1 });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/cannot be approved:\n- Placeholder "\[Phone\]"/);
    expect((await store.getCvVersion(jobId, 1))?.status).toBe('draft');
  });
});
