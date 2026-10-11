import { buildCvDocument } from '../cv/document.ts';
import { runChecks } from '../cv/checks.ts';
import { computeScore, computeVerdict, CritiqueInputSchema, type Critique, type CritiqueInput } from '../cv/critique.ts';
import { hashText } from '../util/text.ts';
import { formatFindings, skillTools } from './commonTools.ts';
import type { AgentDeps } from './deps.ts';
import { noopEmit, type Emit } from './events.ts';
import { runAgent } from './loop.ts';
import { CRITIC_PROMPT } from './prompts.ts';
import { defineTool } from './tool.ts';

export interface CriticOptions {
  jobId: string;
  /** Optional emphasis requested by the caller, e.g. "check the new summary". */
  focus?: string;
  emit?: Emit;
  signal?: AbortSignal;
}

export class CriticError extends Error {}

/** Models occasionally answer with JSON text instead of calling the tool; accept that too. */
export function parseCritiqueFromText(text: string): CritiqueInput | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = CritiqueInputSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function buildCriticSystemPrompt(deps: AgentDeps): Promise<string> {
  const autoloaded = await deps.skills.autoloaded('critic');
  const index = await deps.skills.index('critic');
  return [
    CRITIC_PROMPT,
    ...autoloaded.map((s) => `\n---\n# Skill: ${s.name}\n${s.body}`),
    `\n---\n# Other skills you can read with read_skill\n${index}`,
  ].join('\n');
}

export async function pageCountFor(deps: AgentDeps, jobId: string): Promise<number | undefined> {
  if (!deps.pdf) return undefined;
  const html = await deps.store.readCv(jobId);
  if (!html?.trim()) return undefined;
  try {
    const css = await deps.store.readStyle(jobId);
    return (await deps.pdf.render(buildCvDocument({ html, css }))).pageCount;
  } catch {
    return undefined;
  }
}

/** Runs the critic subagent for a job's CV, stores and returns the critique. */
export async function runCritic(deps: AgentDeps, opts: CriticOptions): Promise<Critique> {
  const { store } = deps;
  const emit = opts.emit ?? noopEmit;
  const job = await store.requireJob(opts.jobId);
  const cv = await store.readCv(opts.jobId);
  if (!cv?.trim()) throw new CriticError('There is no CV for this job yet — write one first.');
  const profile = await store.readProfile();
  const pageCount = await pageCountFor(deps, opts.jobId);
  const checks = runChecks(cv, { profile, pageCount });

  let submitted: CritiqueInput | null = null;
  const submit = defineTool({
    name: 'submit_critique',
    description: 'Submit your complete critique of the CV. Call exactly once, with every field.',
    schema: CritiqueInputSchema,
    terminal: true,
    async run(input) {
      submitted = input;
      return 'Critique recorded.';
    },
  });

  const task = [
    `# Task\nCritique the CV below for the job "${job.title}" at ${job.company}.`,
    opts.focus ? `Pay particular attention to: ${opts.focus}` : '',
    `# Job listing\n${job.listing.trim() || '(empty)'}`,
    `# Candidate profile (source of truth)\n${profile.trim() || '(The profile is empty — every claim is unsupported.)'}`,
    `# CV (HTML)\n${cv}`,
    `# ${formatFindings(checks)}`,
    'Now call submit_critique.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = await runAgent({
    agent: 'critic',
    model: deps.models.critic,
    system: await buildCriticSystemPrompt(deps),
    history: [{ role: 'user', content: task }],
    tools: [...skillTools(deps.skills, 'critic'), submit],
    maxSteps: 6,
    emit,
    signal: opts.signal,
  });

  const input: CritiqueInput | null = submitted ?? parseCritiqueFromText(result.finalText);
  if (!input) throw new CriticError('The critic did not return a valid critique.');

  const score = computeScore(input.scores);
  const critique: Critique = {
    ...input,
    score,
    verdict: computeVerdict(input, score, checks),
    checks,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    cvHash: hashText(cv),
    focus: opts.focus,
  };
  await store.addCritique(opts.jobId, critique);
  emit({ type: 'artifact', kind: 'critique', jobId: opts.jobId });
  return critique;
}
