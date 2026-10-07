import { z } from 'zod';
import { checkCv, formatChecks } from '../cv/checks.js';
import { CvDocumentSchema, type AgentRun, type CheckReport, type Critique, type CvVersion } from '../domain/schemas.js';
import type { ChatModel, Think } from '../llm/types.js';
import type { Store } from '../storage/store.js';
import { shortId } from '../util/ids.js';
import { defineTool, runAgent, ToolError, type Emit } from './agent.js';
import { runCritic, summariseCritique, type CriticDeps } from './critic.js';
import { WRITER_SYSTEM } from './prompts.js';

export const MAX_SAVES_PER_RUN = 4;
export const MAX_CRITIQUES_PER_RUN = 2;

export interface WriterDeps {
  store: Store;
  llm: ChatModel;
  model: string;
  think?: Think;
  emit?: Emit;
  critic: Omit<CriticDeps, 'store' | 'emit'>;
}

export interface WriterRequest {
  jobId: string;
  /** What the coordinator wants: focus, emphasis, length, things to fix. */
  instructions: string;
  baseVersion?: number;
  /** The user's own words about what to change, passed through verbatim. */
  userFeedback?: string;
}

export interface WriterResult {
  runId: string;
  versions: number[];
  latest?: { version: number; checks: CheckReport; critique?: Critique };
  /** The writer's closing note: what it did and what information it lacked. */
  notes: string;
}

export function writerBrief(params: {
  request: WriterRequest;
  job: unknown;
  profile: unknown;
  base?: CvVersion;
}): string {
  const { request, base } = params;
  const parts = ['# Task', request.instructions.trim() || 'Write a strong, tailored CV for this job.'];
  if (request.userFeedback) parts.push('', "# The user's feedback, verbatim (this takes priority)", request.userFeedback);
  if (base) {
    parts.push(
      '',
      `# Version to revise: v${base.version}`,
      'Keep what works; change what the task and feedback ask for. Save the result as a new version.',
      '```json',
      JSON.stringify(base.document, null, 1),
      '```',
      '',
      `Automatic checks on v${base.version}:`,
      formatChecks(base.checks),
    );
    const critique = base.critiques.at(-1);
    if (critique) parts.push('', `Latest critic review of v${base.version}:`, summariseCritique(critique));
  }
  parts.push(
    '',
    '# Job listing',
    '```json',
    JSON.stringify(params.job, null, 1),
    '```',
    '',
    '# Candidate profile — the ONLY source of facts. Cite entry ids in `sources`.',
    '```json',
    JSON.stringify(params.profile, null, 1),
    '```',
  );
  return parts.join('\n');
}

/**
 * The writer agent: drafts or revises a CV for one job, saving each draft as a new version
 * (checked automatically), and may ask the critic for a review before finishing.
 */
export async function runWriter(deps: WriterDeps, request: WriterRequest): Promise<WriterResult> {
  const { store } = deps;
  const [job, profile] = await Promise.all([store.getJob(request.jobId), store.getProfile()]);
  const base = request.baseVersion !== undefined ? await store.getCvVersion(request.jobId, request.baseVersion) : undefined;
  const brief = writerBrief({ request, job, profile, ...(base ? { base } : {}) });
  const runId = `writer-${shortId(4)}`;
  const run: AgentRun = {
    id: runId,
    agent: 'writer',
    model: deps.model,
    requestedBy: 'coordinator',
    jobId: request.jobId,
    startedAt: new Date().toISOString(),
    outcome: 'running',
    system: WRITER_SYSTEM,
    brief,
    messages: [],
    usage: { promptTokens: 0, outputTokens: 0, calls: 0 },
  };
  const saved: CvVersion[] = [];
  const critiques = new Map<number, Critique>();
  let critiqueCount = 0;
  deps.emit?.({ type: 'activity', agent: 'writer', text: base ? `Writer is revising v${base.version}…` : 'Writer is drafting a new CV…' });

  const saveCv = defineTool({
    name: 'save_cv',
    description:
      'Save a complete CV as a new version. Every save is checked automatically against the profile; the result lists any errors you must fix.',
    schema: z.object({
      document: CvDocumentSchema,
      changeSummary: z.string().describe('One or two sentences: what this version does or changes.'),
    }),
    mutates: true,
    label: () => 'Saving a CV draft',
    run: async ({ document, changeSummary }) => {
      if (saved.length >= MAX_SAVES_PER_RUN) throw new ToolError(`You have used all ${MAX_SAVES_PER_RUN} saves for this run. Finish with your notes.`);
      const ready = [...critiques].find(([, c]) => c.verdict === 'ready');
      if (ready) throw new ToolError(`The critic rated v${ready[0]} ready. Stop here so a ready CV is not reworded into a weaker one; finish with your notes, including any optional polish as suggestions.`);
      const current = await store.getProfile();
      const checks = checkCv(document, current, job);
      const previous = saved.at(-1)?.version ?? request.baseVersion;
      const cv = await store.addCvVersion({
        jobId: request.jobId,
        profileRevision: current.revision,
        ...(previous !== undefined ? { basedOnVersion: previous } : {}),
        ...(request.userFeedback ? { feedback: request.userFeedback } : {}),
        writerRunId: runId,
        changeSummary,
        document,
        checks,
      });
      saved.push(cv);
      deps.emit?.({ type: 'activity', agent: 'writer', text: `Writer saved v${cv.version} (${checks.errorCount} errors, ${checks.warningCount} warnings)` });
      deps.emit?.({ type: 'state', changed: ['cvs'] });
      const savesLeft = MAX_SAVES_PER_RUN - saved.length;
      return {
        version: cv.version,
        errors: checks.checks.filter((c) => c.severity === 'error'),
        warnings: checks.checks.filter((c) => c.severity === 'warning'),
        keywordCoverage: checks.keywordCoverage,
        savesLeft,
        next:
          checks.errorCount > 0
            ? `v${cv.version} has ${checks.errorCount} error(s). Fix every error and save again (${savesLeft} saves left).`
            : critiqueCount < MAX_CRITIQUES_PER_RUN
              ? `v${cv.version} passed the automatic checks. Call request_critique for v${cv.version}.`
              : 'Finish with your notes.',
      };
    },
  });

  const requestCritique = defineTool({
    name: 'request_critique',
    description: 'Ask the critic to grade a version you saved in this run against the job listing and the profile.',
    schema: z.object({ version: z.coerce.number().int() }),
    label: ({ version }) => `Asking the critic to review v${version}`,
    run: async ({ version }) => {
      if (!saved.some((v) => v.version === version)) throw new ToolError(`v${version} was not saved in this run. Versions you saved: ${saved.map((v) => v.version).join(', ') || 'none'}.`);
      if (critiqueCount >= MAX_CRITIQUES_PER_RUN) throw new ToolError(`You have used all ${MAX_CRITIQUES_PER_RUN} critiques for this run. Finish with your notes.`);
      critiqueCount += 1;
      const critique = await runCritic({ ...deps.critic, store, ...(deps.emit ? { emit: deps.emit } : {}) }, { jobId: request.jobId, version, requestedBy: 'writer' });
      critiques.set(version, critique);
      const fixable = critique.issues.filter((i) => i.severity !== 'minor');
      return {
        review: summariseCritique(critique),
        next:
          critique.verdict === 'ready'
            ? `v${version} is rated ready. Finish now with your notes (do not save again); mention any optional polish as suggestions.`
            : fixable.length && saved.length < MAX_SAVES_PER_RUN
            ? 'Fix the critical and major issues you can fix from the profile (never invent facts), then save again. Put anything needing the user in your final notes.'
            : 'Finish with your notes.',
      };
    },
  });

  try {
    const result = await runAgent(
      {
        name: 'writer',
        model: deps.model,
        llm: deps.llm,
        system: () => WRITER_SYSTEM,
        tools: [saveCv, requestCritique],
        maxSteps: 14,
        ...(deps.think !== undefined ? { think: deps.think } : {}),
        audit: store,
        stream: 'progress',
        ...(deps.emit ? { emit: deps.emit } : {}),
        contextTokens: 100_000,
        beforeFinish: () => {
          const latest = saved.at(-1);
          if (!latest) return 'You have not saved a CV. Call save_cv with the complete document.';
          if (latest.checks.errorCount > 0 && saved.length < MAX_SAVES_PER_RUN)
            return `v${latest.version} still has errors:\n${formatChecks({ ...latest.checks, checks: latest.checks.checks.filter((c) => c.severity === 'error') })}\nFix them and call save_cv again.`;
          if (!critiques.has(latest.version) && critiqueCount < MAX_CRITIQUES_PER_RUN && latest.checks.errorCount === 0)
            return `Call request_critique for v${latest.version} before you finish.`;
          return undefined;
        },
      },
      [{ role: 'user', content: brief }],
    );
    run.messages = [{ role: 'user', content: brief }, ...result.messages];
    run.usage = result.usage;
    run.outcome = saved.length ? 'completed' : 'failed';
    if (!saved.length) run.error = 'No CV was saved.';
    const latest = saved.at(-1);
    const out: WriterResult = {
      runId,
      versions: saved.map((v) => v.version),
      ...(latest
        ? { latest: { version: latest.version, checks: latest.checks, ...(critiques.get(latest.version) ? { critique: critiques.get(latest.version)! } : {}) } }
        : {}),
      notes: result.reply,
    };
    run.result = { versions: out.versions, notes: out.notes };
    return out;
  } catch (err) {
    run.outcome = 'failed';
    run.error = (err as Error).message;
    throw err;
  } finally {
    run.finishedAt = new Date().toISOString();
    await store.saveRun(run);
    await store.audit({ actor: 'writer', action: 'writer_run', outcome: run.outcome === 'completed' ? 'ok' : 'error', details: { runId, jobId: request.jobId, versions: saved.map((v) => v.version), error: run.error } });
  }
}
