import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SAVES_PER_RUN, runWriter, writerBrief, type WriterDeps } from '../../src/agents/writer.js';
import type { Store } from '../../src/storage/store.js';
import { CRITIQUE, CV_DOC, seededStore, tempDir } from '../support/fixtures.js';
import { call, lastToolResult, say, ScriptedModel } from '../support/scripted.js';

let cleanup: () => Promise<void>;
let store: Store;
let jobId: string;
beforeEach(async () => {
  const t = await tempDir();
  cleanup = t.cleanup;
  ({ store, jobId } = (await seededStore(t.dir, { job: true })) as { store: Store; jobId: string });
});
afterEach(() => cleanup());

const deps = (llm: ScriptedModel): WriterDeps => ({ store, llm, model: 'writer', critic: { llm, model: 'critic' } });
const badDoc = { ...CV_DOC, summary: 'Engineer with [X] years of experience who served 1,000,000 users.' };

describe('writer', () => {
  it('drafts, fixes check errors, gets a critique, and reports back', async () => {
    const llm = new ScriptedModel({
      writer: [
        call('save_cv', { document: badDoc, changeSummary: 'first draft' }),
        call('save_cv', { document: CV_DOC, changeSummary: 'fixed placeholder and number' }),
        call('request_critique', { version: 2 }),
        say('v2 is final. Questions: Have you used Terraform?'),
      ],
      critic: [call('submit_review', { ...CRITIQUE }), say('done')],
    });
    const result = await runWriter(deps(llm), { jobId, instructions: 'Emphasise AWS.' });
    expect(result.versions).toEqual([1, 2]);
    expect(result.latest?.version).toBe(2);
    expect(result.latest?.checks.errorCount).toBe(0);
    expect(result.latest?.critique?.requestedBy).toBe('writer');
    expect(result.notes).toMatch(/Terraform/);

    const first = lastToolResult(llm.requestsFor('writer')[1]!);
    expect(first.version).toBe(1);
    expect((first.errors as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect(String(first.next)).toMatch(/Fix every error/);
    expect(String(lastToolResult(llm.requestsFor('writer')[2]!).next)).toMatch(/request_critique for v2/);

    const v1 = await store.getCvVersion(jobId, 1);
    const v2 = await store.getCvVersion(jobId, 2);
    expect(v1.checks.errorCount).toBeGreaterThan(0);
    expect(v2.basedOnVersion).toBe(1);
    expect(v2.writerRunId).toBe(result.runId);
    expect(v2.profileRevision).toBe(1);
    expect(v2.critiques).toHaveLength(1);
    const run = await store.getRun(result.runId);
    expect(run).toMatchObject({ agent: 'writer', outcome: 'completed' });
    expect(run.brief).toContain('Emphasise AWS.');
  });

  it('revises a base version with the user feedback verbatim and the previous review', async () => {
    const llm = new ScriptedModel({
      writer: [call('save_cv', { document: CV_DOC, changeSummary: 'v1' }), call('request_critique', { version: 1 }), say('ok')],
      critic: [call('submit_review', { ...CRITIQUE }), say('done')],
    });
    await runWriter(deps(llm), { jobId, instructions: 'Draft.' });
    const llm2 = new ScriptedModel({
      writer: [call('save_cv', { document: CV_DOC, changeSummary: 'shorter' }), call('request_critique', { version: 2 }), say('v2 done')],
      critic: [call('submit_review', { ...CRITIQUE, overallScore: 88, verdict: 'ready', issues: [] }), say('done')],
    });
    const result = await runWriter(deps(llm2), { jobId, instructions: 'Tighten.', baseVersion: 1, userFeedback: 'Make it one page please!' });
    const brief = llm2.requestsFor('writer')[0]!.messages[1]!.content;
    expect(brief).toContain("# The user's feedback, verbatim (this takes priority)\nMake it one page please!");
    expect(brief).toContain('# Version to revise: v1');
    expect(brief).toContain('Latest critic review of v1:');
    const v2 = await store.getCvVersion(jobId, result.latest!.version);
    expect(v2).toMatchObject({ basedOnVersion: 1, feedback: 'Make it one page please!' });
  });

  it('is reminded to save, to fix errors, and to ask for a critique before finishing', async () => {
    const llm = new ScriptedModel({
      writer: [say('All done!'), call('save_cv', { document: CV_DOC, changeSummary: 'draft' }), say('Finished.'), call('request_critique', { version: 1 }), say('Really finished.')],
      critic: [call('submit_review', { ...CRITIQUE }), say('done')],
    });
    const result = await runWriter(deps(llm), { jobId, instructions: '' });
    const writerRequests = llm.requestsFor('writer');
    expect(writerRequests[1]!.messages.at(-1)!.content).toMatch(/You have not saved a CV/);
    expect(writerRequests[3]!.messages.at(-1)!.content).toMatch(/Call request_critique for v1/);
    expect(result.latest?.critique).toBeDefined();
  });

  it('stops once the critic rates a version ready, so it is not reworded into a weaker one', async () => {
    const llm = new ScriptedModel({
      writer: [call('save_cv', { document: CV_DOC, changeSummary: 'draft' }), call('request_critique', { version: 1 }), call('save_cv', { document: CV_DOC, changeSummary: 'polish' }), say('v1 is final.')],
      critic: [call('submit_review', { ...CRITIQUE, overallScore: 88, verdict: 'ready', issues: [] }), say('done')],
    });
    const result = await runWriter(deps(llm), { jobId, instructions: 'x' });
    const writerRequests = llm.requestsFor('writer');
    expect(String(lastToolResult(writerRequests[2]!).next)).toMatch(/v1 is rated ready\. Finish now/);
    expect(String(lastToolResult(writerRequests[3]!).error)).toMatch(/rated v1 ready\. Stop here/);
    expect(result.versions).toEqual([1]);
    expect(result.latest?.critique?.verdict).toBe('ready');
  });

  it('enforces the save budget and refuses critiques of versions it did not save', async () => {
    const saves = Array.from({ length: MAX_SAVES_PER_RUN + 1 }, () => call('save_cv', { document: badDoc, changeSummary: 'again' }));
    const llm = new ScriptedModel({ writer: [call('request_critique', { version: 7 }), ...saves, say('I could not fix it.'), say('Still no.')] });
    const result = await runWriter(deps(llm), { jobId, instructions: 'x' });
    expect(String(lastToolResult(llm.requestsFor('writer')[1]!).error)).toMatch(/v7 was not saved in this run/);
    expect(result.versions).toHaveLength(MAX_SAVES_PER_RUN);
    expect(String(lastToolResult(llm.requestsFor('writer')[MAX_SAVES_PER_RUN + 2]!).error)).toMatch(/used all 4 saves/);
    expect(result.latest?.checks.errorCount).toBeGreaterThan(0);
  });

  it('records a failed run when nothing is saved', async () => {
    const llm = new ScriptedModel({ writer: [say('no'), say('no'), say('no')] });
    const result = await runWriter(deps(llm), { jobId, instructions: 'x' });
    expect(result.versions).toEqual([]);
    expect(result.latest).toBeUndefined();
    expect((await store.getRun(result.runId)).outcome).toBe('failed');
    expect((await store.readAudit()).at(-1)).toMatchObject({ actor: 'writer', action: 'writer_run', outcome: 'error' });
  });

  it('builds a brief with the job listing and the profile as the only source of facts', () => {
    const brief = writerBrief({ request: { jobId: 'j', instructions: '  ' }, job: { title: 'T' }, profile: { contact: {} } });
    expect(brief).toMatch(/Write a strong, tailored CV/);
    expect(brief).toMatch(/# Candidate profile — the ONLY source of facts/);
  });
});
