import { checkCv, formatChecks } from '../cv/checks.js';
import { CritiqueInputSchema, type AgentRun, type Critique, type CritiqueInput } from '../domain/schemas.js';
import type { ChatModel, Think } from '../llm/types.js';
import type { Store } from '../storage/store.js';
import { shortId } from '../util/ids.js';
import { defineTool, runAgent, ToolError, type Emit } from './agent.js';
import { CRITIC_SYSTEM } from './prompts.js';

export interface CriticDeps {
  store: Store;
  llm: ChatModel;
  model: string;
  think?: Think;
  emit?: Emit;
}

export function criticBrief(params: { job: unknown; profile: unknown; document: unknown; checks: string; version: number }): string {
  return [
    `# CV to review: version ${params.version}`,
    '```json',
    JSON.stringify(params.document, null, 1),
    '```',
    '',
    '# Automatic checks already run on this version',
    params.checks,
    '',
    '# Job listing',
    '```json',
    JSON.stringify(params.job, null, 1),
    '```',
    '',
    '# Candidate profile (the only source of truth about the candidate)',
    '```json',
    JSON.stringify(params.profile, null, 1),
    '```',
    '',
    'Review the CV and call submit_review once.',
  ].join('\n');
}

/**
 * Applies the review rubric in code, whatever model the critic runs on: anything untrue to the
 * profile is critical, and the verdict cannot be better than the worst issue allows.
 */
export function enforceRubric(review: CritiqueInput): CritiqueInput {
  const issues = review.issues.map((i) => (i.category === 'factual' ? { ...i, severity: 'critical' as const } : i));
  const verdict = issues.some((i) => i.severity === 'critical')
    ? 'not_ready'
    : issues.some((i) => i.severity === 'major') && review.verdict === 'ready'
      ? 'needs_work'
      : review.verdict;
  return { ...review, issues, verdict };
}

/** One line per thing that matters, for agents that act on a review. */
export function summariseCritique(c: CritiqueInput): string {
  const lines = [
    `Score ${c.overallScore}/100, verdict: ${c.verdict}. ${c.summary}`,
    `Scores — relevance ${c.scores.relevance}, impact ${c.scores.impact}, clarity ${c.scores.clarity}, accuracy ${c.scores.accuracy}, presentation ${c.scores.presentation}.`,
  ];
  if (c.issues.length) lines.push('Issues:', ...c.issues.map((i) => `- [${i.severity}/${i.category}]${i.location ? ` ${i.location}:` : ''} ${i.problem}${i.suggestion ? ` → ${i.suggestion}` : ''}`));
  const gaps = c.requirementCoverage.filter((r) => r.status !== 'met');
  if (gaps.length) lines.push('Requirements not fully evidenced:', ...gaps.map((r) => `- (${r.status}) ${r.requirement}${r.evidence ? ` — ${r.evidence}` : ''}`));
  if (c.questionsForUser.length) lines.push('Questions only the user can answer:', ...c.questionsForUser.map((q) => `- ${q}`));
  return lines.join('\n');
}

/**
 * The critic agent: grades a saved CV version against the job listing, looks for outright mistakes,
 * and checks every claim against the profile. Its review is stored on the version.
 */
export async function runCritic(deps: CriticDeps, params: { jobId: string; version: number; requestedBy: 'coordinator' | 'writer' }): Promise<Critique> {
  const { store } = deps;
  const [job, cv, profile] = await Promise.all([store.getJob(params.jobId), store.getCvVersion(params.jobId, params.version), store.getProfile()]);
  const checks = checkCv(cv.document, profile, job);
  const brief = criticBrief({ job, profile, document: cv.document, checks: formatChecks(checks), version: cv.version });
  const runId = `critic-${shortId(4)}`;
  const run: AgentRun = {
    id: runId,
    agent: 'critic',
    model: deps.model,
    requestedBy: params.requestedBy,
    jobId: params.jobId,
    startedAt: new Date().toISOString(),
    outcome: 'running',
    system: CRITIC_SYSTEM,
    brief,
    messages: [],
    usage: { promptTokens: 0, outputTokens: 0, calls: 0 },
  };
  deps.emit?.({ type: 'activity', agent: 'critic', text: `Critic is reviewing v${cv.version}…` });

  let submitted: CritiqueInput | undefined;
  const submit = defineTool({
    name: 'submit_review',
    description: 'Submit your review of the CV. Call exactly once.',
    schema: CritiqueInputSchema,
    label: () => 'Submitting review',
    run: async (review) => {
      if (submitted) throw new ToolError('Review already submitted. Reply "done".');
      submitted = review;
      return { ok: true, next: 'Review recorded. Reply "done".' };
    },
  });

  try {
    const result = await runAgent(
      {
        name: 'critic',
        model: deps.model,
        llm: deps.llm,
        system: () => CRITIC_SYSTEM,
        tools: [submit],
        maxSteps: 5,
        ...(deps.think !== undefined ? { think: deps.think } : {}),
        audit: store,
        stream: 'progress',
        ...(deps.emit ? { emit: deps.emit } : {}),
        beforeFinish: () => (submitted ? undefined : 'You have not submitted your review. Call submit_review now with the full review.'),
      },
      [{ role: 'user', content: brief }],
    );
    run.messages = [{ role: 'user', content: brief }, ...result.messages];
    run.usage = result.usage;
    if (!submitted) throw new Error('The critic did not submit a review.');
    const critique: Critique = { ...enforceRubric(submitted), at: new Date().toISOString(), requestedBy: params.requestedBy, runId, model: deps.model };
    await store.updateCvVersion(params.jobId, params.version, (v) => ({ ...v, critiques: [...v.critiques, critique] }));
    run.outcome = 'completed';
    run.result = critique;
    await store.audit({ actor: 'critic', action: 'review', outcome: 'ok', details: { jobId: params.jobId, version: params.version, score: critique.overallScore, verdict: critique.verdict, runId } });
    deps.emit?.({ type: 'activity', agent: 'critic', text: `Critic scored v${cv.version} ${critique.overallScore}/100 (${critique.verdict.replace('_', ' ')})` });
    deps.emit?.({ type: 'state', changed: ['cvs'] });
    return critique;
  } catch (err) {
    run.outcome = 'failed';
    run.error = (err as Error).message;
    await store.audit({ actor: 'critic', action: 'review', outcome: 'error', details: { jobId: params.jobId, version: params.version, error: run.error, runId } });
    throw err;
  } finally {
    run.finishedAt = new Date().toISOString();
    await store.saveRun(run);
  }
}
