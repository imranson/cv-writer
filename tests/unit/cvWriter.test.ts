import { describe, expect, it } from 'vitest';
import { MAX_SAVES_PER_RUN, nextStep, runCvWriter, writerBrief } from '../../src/agents/cvWriter.js';
import { CV_WRITER } from '../../src/agents/prompts.js';
import { renderMarkdown } from '../../src/cv/render.js';
import { verifyCv } from '../../src/cv/verify.js';
import { JobListingSchema } from '../../src/domain/schemas.js';
import { LlmError } from '../../src/llm/ollama.js';
import { emptyUsage } from '../../src/llm/types.js';
import type { CvStore } from '../../src/storage/store.js';
import { sampleCv, sampleJob, sampleProfile, seedProfile, tempStore } from '../helpers.js';
import { call, lastToolResult, say, ScriptedModel, type Step } from '../support/scripted.js';

async function setup(steps: Step[]) {
  const store = await tempStore();
  await seedProfile(store);
  const job = await store.saveJob(sampleJob());
  const model = new ScriptedModel(steps);
  const usage = emptyUsage();
  const deps = { store, client: model, model: 'writer-model', sessionId: 'session-s1', usage, today: 'Sun Oct 04 2026' };
  return { store, job, model, usage, deps };
}

const save = (document = sampleCv(), changeSummary = 'Tailored to the role') => call('save_cv_version', { document, changeSummary });

function withPlaceholder() {
  const doc = sampleCv();
  doc.contactLine.push('[LinkedIn]');
  return doc;
}

async function saveDirect(store: CvStore, jobId: string) {
  const doc = sampleCv();
  return store.saveCvVersion({
    jobId,
    profileRevision: 1,
    changeSummary: 'earlier',
    document: doc,
    markdown: renderMarkdown(doc),
    verification: verifyCv(doc, sampleProfile()),
  });
}

describe('writerBrief', () => {
  it('gives a fresh draft the job and profile', () => {
    const job = JobListingSchema.parse({ ...sampleJob(), id: 'acme-1', createdAt: 'x' });
    const brief = writerBrief({ jobId: 'acme-1', notes: 'One page please' }, job, sampleProfile());
    expect(brief).toMatch(/^# Task\nWrite a CV for job "acme-1" \(Graduate Software Engineer at Acme Health\)\./);
    expect(brief).toContain('## Notes from the coordinator\nOne page please');
    expect(brief).toContain('# Candidate profile (revision 3)');
    expect(brief).toContain('"id": "experience-1"');
    expect(brief).toContain('"keywords": [');
    expect(brief).not.toContain('Feedback');
  });

  it('gives a revision the version to revise, its issues and the feedback', () => {
    const job = JobListingSchema.parse({ ...sampleJob(), id: 'acme-1', createdAt: 'x' });
    const doc = withPlaceholder();
    const base = {
      jobId: 'acme-1',
      version: 2,
      createdAt: 'x',
      status: 'draft' as const,
      profileRevision: 3,
      changeSummary: 's',
      document: doc,
      markdown: renderMarkdown(doc),
      verification: verifyCv(doc, sampleProfile(), job),
    };
    const brief = writerBrief({ jobId: 'acme-1', basedOnVersion: 2, feedback: 'Shorter profile' }, job, sampleProfile(), base);
    expect(brief).toMatch(/^# Task\nRevise CV version 2/);
    expect(brief).toContain("## Feedback to address (the candidate's words)\nShorter profile");
    expect(brief).toContain('# Version 2 (the one to revise)');
    expect(brief).toContain('- error: Placeholder "[LinkedIn]"');
  });
});

describe('nextStep', () => {
  const version = (passed: boolean, severities: Array<'error' | 'warning'>) =>
    ({ verification: { passed, issues: severities.map((severity) => ({ severity, code: 'c', message: 'm' })) } }) as never;

  it('says when to stop and when another save is worth it', () => {
    expect(nextStep(version(true, []), 2)).toMatch(/^All checks passed\. Do not save again/);
    expect(nextStep(version(false, ['error']), 2)).toBe('Fix every error, then save again.');
    expect(nextStep(version(true, ['warning']), 1)).toMatch(/^Only warnings remain\./);
    expect(nextStep(version(false, ['error']), 0)).toMatch(/^No saves left\./);
  });
});

describe('runCvWriter', () => {
  it('drafts a CV in its own context and saves it as a verified, traceable version', async () => {
    const { store, job, model, usage, deps } = await setup([save(), say('Saved version 1. Led with the research internship.')]);
    const outcome = await runCvWriter({ jobId: job.id }, deps);

    expect(outcome).toMatchObject({ savedVersions: [1], reply: 'Saved version 1. Led with the research internship.' });
    expect(outcome.version).toMatchObject({ version: 1, profileRevision: 1, writerRunId: outcome.runId, status: 'draft' });
    expect(outcome.version!.verification.passed).toBe(true);
    expect(outcome.version!.markdown).toBe(renderMarkdown(sampleCv()));

    // A separate agent: its own model, system prompt and only the save tool.
    const first = model.requests[0]!;
    expect(first.model).toBe('writer-model');
    expect(first.messages[0]!.content).toMatch(/^You are an expert CV writer\./);
    expect(first.messages[0]!.content).toContain('Today is Sun Oct 04 2026.');
    expect(first.messages[1]!.content).toContain(`Write a CV for job "${job.id}"`);
    expect(first.tools!.map((t) => t.function.name)).toEqual(['save_cv_version']);
    expect(lastToolResult(model.requests[1]!).json()).toMatchObject({
      version: 1,
      verificationPassed: true,
      savesLeft: 2,
      nextStep: 'All checks passed. Do not save again; reply to the coordinator now.',
    });

    const run = (await store.getWriterRun(outcome.runId))!;
    expect(run).toMatchObject({ sessionId: 'session-s1', jobId: job.id, model: 'writer-model', outcome: 'saved', savedVersions: [1] });
    expect(run.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(run.systemPrompt).toBe(first.messages[0]!.content);
    expect(run.usage).toEqual({ requests: 2, promptTokens: 200, outputTokens: 40 });
    expect(usage).toEqual(run.usage);
    expect((await store.listWriterRuns(job.id)).map((r) => r.id)).toEqual([outcome.runId]);

    const audit = await store.readAudit();
    expect(audit.map((e) => [e.actor, e.action, e.ok])).toEqual([['cv-writer', 'save_cv_version', true]]);
  });

  it('fixes verification errors itself, chaining the versions it saves', async () => {
    const { store, job, model, deps } = await setup([
      save(withPlaceholder(), 'First pass'),
      (req) => {
        const report = lastToolResult(req).json();
        expect(report.verificationPassed).toBe(false);
        expect(report.issues[0].code).toBe('placeholder');
        expect(report.nextStep).toBe('Fix every error, then save again.');
        return save(sampleCv(), 'Removed the placeholder');
      },
      say('Version 2 is clean.'),
    ]);
    const outcome = await runCvWriter({ jobId: job.id }, deps);
    expect(outcome.savedVersions).toEqual([1, 2]);
    expect(outcome.version!.version).toBe(2);
    const [v1, v2] = await store.listCvVersions(job.id);
    expect(v1).toMatchObject({ verification: { passed: false } });
    expect(v1).not.toHaveProperty('basedOnVersion');
    expect(v2).toMatchObject({ basedOnVersion: 1, writerRunId: outcome.runId, verification: { passed: true } });
    expect(model.remaining).toBe(0);
  });

  it('revises a given version, recording the feedback on every save', async () => {
    const { store, job, deps } = await setup([save(), say('Done.')]);
    await saveDirect(store, job.id);
    const outcome = await runCvWriter({ jobId: job.id, basedOnVersion: 1, feedback: 'Mention AWS earlier' }, deps);
    expect(outcome.version).toMatchObject({ version: 2, basedOnVersion: 1, feedback: 'Mention AWS earlier' });
  });

  it(`refuses more than ${MAX_SAVES_PER_RUN} saves in one run`, async () => {
    const { model, job, deps } = await setup([save(), save(), save(), save(), say('Stopping.')]);
    const outcome = await runCvWriter({ jobId: job.id }, deps);
    expect(outcome.savedVersions).toEqual([1, 2, 3]);
    expect(lastToolResult(model.requests[4]!).content).toMatch(/already saved 3 versions/);
  });

  it('reminds the writer to save, and reports when it never does', async () => {
    const nudged = await setup([say('Here is a CV: ...'), save(), say('Saved.')]);
    const outcome = await runCvWriter({ jobId: nudged.job.id }, nudged.deps);
    expect(outcome.savedVersions).toEqual([1]);
    expect(nudged.model.requests[1]!.messages.at(-1)!.content).toMatch(/You have not saved a CV yet/);

    const stubborn = await setup([say('No.'), say('Still no.')]);
    const none = await runCvWriter({ jobId: stubborn.job.id }, stubborn.deps);
    expect(none).toEqual({ runId: none.runId, savedVersions: [], reply: 'Still no.' });
    expect((await stubborn.store.getWriterRun(none.runId))!.outcome).toBe('no-cv');
  });

  it('cannot use coordinator tools', async () => {
    const { store, model, job, deps } = await setup([call('update_contact', { name: 'Someone Else' }), save(), say('ok')]);
    await runCvWriter({ jobId: job.id }, deps);
    expect(lastToolResult(model.requests[1]!).content).toMatch(/no tool "update_contact" available to the cv-writer/);
    expect((await store.getProfile()).contact.name).toBe('Alex Morgan');
    const denied = (await store.readAudit()).find((e) => e.action === 'update_contact');
    expect(denied).toMatchObject({ actor: CV_WRITER, ok: false, detail: { denied: expect.any(String) } });
  });

  it('records failed runs and rethrows when nothing was saved', async () => {
    const { store, job, deps } = await setup([
      () => {
        throw new LlmError('Ollama request failed (500): boom', false, 500);
      },
    ]);
    await expect(runCvWriter({ jobId: job.id }, deps)).rejects.toThrow('boom');
    const [run] = await store.listWriterRuns();
    expect(run).toMatchObject({ outcome: 'failed', error: 'Ollama request failed (500): boom', savedVersions: [] });
  });

  it('still returns a draft saved before a failure', async () => {
    const { store, job, deps } = await setup([
      save(),
      () => {
        throw new Error('connection reset');
      },
    ]);
    const outcome = await runCvWriter({ jobId: job.id }, deps);
    expect(outcome.version!.version).toBe(1);
    expect(outcome.reply).toMatch(/stopped early after saving: connection reset/);
    expect((await store.getWriterRun(outcome.runId))!).toMatchObject({ outcome: 'saved', error: 'connection reset' });
  });

  it('rejects unknown jobs and versions before calling the model', async () => {
    const { model, job, deps } = await setup([]);
    await expect(runCvWriter({ jobId: 'nope' }, deps)).rejects.toThrow('No job listing "nope"');
    await expect(runCvWriter({ jobId: job.id, basedOnVersion: 4 }, deps)).rejects.toThrow('Version 4 does not exist');
    expect(model.requests).toHaveLength(0);
  });
});
