import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agents/agent.js';
import { criticBrief, enforceRubric, runCritic, summariseCritique } from '../../src/agents/critic.js';
import { checkCv } from '../../src/cv/checks.js';
import { CritiqueInputSchema } from '../../src/domain/schemas.js';
import type { Store } from '../../src/storage/store.js';
import { CRITIQUE, CV_DOC, PROFILE, seededStore, tempDir } from '../support/fixtures.js';
import { call, say, ScriptedModel } from '../support/scripted.js';

let cleanup: () => Promise<void>;
let store: Store;
let jobId: string;
beforeEach(async () => {
  const t = await tempDir();
  cleanup = t.cleanup;
  ({ store, jobId } = (await seededStore(t.dir, { job: true })) as { store: Store; jobId: string });
  await store.addCvVersion({ jobId, profileRevision: 1, writerRunId: 'writer-x', document: CV_DOC, checks: checkCv(CV_DOC, PROFILE) });
});
afterEach(() => cleanup());

describe('critic', () => {
  it('reviews a version with the job, profile, CV and checks, and stores the review on it', async () => {
    const llm = new ScriptedModel({ critic: [call('submit_review', { ...CRITIQUE }), say('done')] });
    const events: AgentEvent[] = [];
    const critique = await runCritic({ store, llm, model: 'critic', emit: (e) => events.push(e) }, { jobId, version: 1, requestedBy: 'coordinator' });
    expect(critique).toMatchObject({ overallScore: 78, verdict: 'needs_work', requestedBy: 'coordinator', model: 'critic' });
    const brief = llm.requests[0]!.messages[1]!.content;
    expect(brief).toContain('# CV to review: version 1');
    expect(brief).toContain('Babbage Systems');
    expect(brief).toContain('experience-aaa111');
    expect(brief).toContain('job keywords appear in the CV');
    expect(llm.requests[0]!.tools!.map((t) => t.function.name)).toEqual(['submit_review']);
    const stored = await store.getCvVersion(jobId, 1);
    expect(stored.critiques).toHaveLength(1);
    const run = await store.getRun(critique.runId);
    expect(run).toMatchObject({ agent: 'critic', outcome: 'completed', requestedBy: 'coordinator' });
    expect(run.messages.length).toBeGreaterThan(1);
    expect(events.filter((e) => e.type === 'activity').map((e) => (e as { text: string }).text)).toEqual(['Critic is reviewing v1…', 'Critic scored v1 78/100 (needs work)']);
    expect((await store.readAudit()).at(-1)).toMatchObject({ actor: 'critic', action: 'review', outcome: 'ok' });
  });

  it('reminds the critic to submit, and accepts scores sent as strings', async () => {
    const llm = new ScriptedModel({ critic: [say('Looks fine.'), call('submit_review', { ...CRITIQUE, overallScore: '81' }), say('done')] });
    const critique = await runCritic({ store, llm, model: 'critic' }, { jobId, version: 1, requestedBy: 'writer' });
    expect(critique.overallScore).toBe(81);
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/not submitted your review/);
  });

  it('fails, records the failed run, and leaves the version unreviewed when no review comes', async () => {
    const llm = new ScriptedModel({ critic: [say('meh'), say('meh'), say('meh')] });
    await expect(runCritic({ store, llm, model: 'critic' }, { jobId, version: 1, requestedBy: 'writer' })).rejects.toThrow(/did not submit/);
    expect((await store.getCvVersion(jobId, 1)).critiques).toEqual([]);
    expect((await store.readAudit()).at(-1)).toMatchObject({ actor: 'critic', outcome: 'error' });
  });

  it('treats anything untrue to the profile as critical and keeps the verdict consistent', async () => {
    const lenient = { ...CRITIQUE, verdict: 'ready' as const, issues: [{ severity: 'minor' as const, category: 'factual' as const, problem: 'Claims presenting to stakeholders; not in profile' }] };
    expect(enforceRubric(lenient)).toMatchObject({ verdict: 'not_ready', issues: [{ severity: 'critical' }] });
    expect(enforceRubric({ ...CRITIQUE, verdict: 'ready' }).verdict).toBe('needs_work');
    expect(enforceRubric({ ...CRITIQUE, verdict: 'ready', issues: [] }).verdict).toBe('ready');
    const llm = new ScriptedModel({ critic: [call('submit_review', lenient), say('done')] });
    const stored = await runCritic({ store, llm, model: 'critic' }, { jobId, version: 1, requestedBy: 'coordinator' });
    expect(stored.verdict).toBe('not_ready');
  });

  it('accepts the usual variations models produce in a review', () => {
    const parsed = CritiqueInputSchema.parse({
      ...CRITIQUE,
      verdict: 'Needs work',
      requirementCoverage: [{ requirement: 'SQL', status: 'partially_met' }, { requirement: 'Power BI', status: 'Not met' }],
      issues: [{ severity: 'critical', location: 'bullet 4', suggestion: 'Remove the invented claim' }, { severity: 'HIGH', category: 'Formatting', description: 'Too long' }],
    });
    expect(parsed.verdict).toBe('needs_work');
    expect(parsed.requirementCoverage.map((r) => r.status)).toEqual(['partial', 'missing']);
    expect(parsed.issues).toEqual([
      { severity: 'critical', category: 'wording', location: 'bullet 4', problem: 'Remove the invented claim', suggestion: 'Remove the invented claim' },
      { severity: 'major', category: 'presentation', problem: 'Too long' },
    ]);
    expect(() => CritiqueInputSchema.parse({ ...CRITIQUE, verdict: 'great' })).toThrow();
  });

  it('summarises a review for other agents', () => {
    const text = summariseCritique(CRITIQUE);
    expect(text).toMatch(/Score 78\/100, verdict: needs_work/);
    expect(text).toMatch(/\[major\/coverage\] No infrastructure-as-code evidence → Ask about Terraform/);
    expect(text).toMatch(/\(missing\) Terraform/);
    expect(text).toMatch(/Have you used Terraform\?/);
    expect(criticBrief({ job: {}, profile: {}, document: {}, checks: 'ok', version: 2 })).toMatch(/version 2/);
  });
});
