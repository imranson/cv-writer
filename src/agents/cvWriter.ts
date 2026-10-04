import { z } from 'zod';
import { renderMarkdown } from '../cv/render.js';
import { verifyCv } from '../cv/verify.js';
import { CvDocumentSchema, type CvVersion, type JobListing, type Profile } from '../domain/schemas.js';
import { emptyUsage, type ChatClient, type Think, type Usage } from '../llm/types.js';
import type { CvStore } from '../storage/store.js';
import { Agent, defineTool, type AgentEvent } from './agent.js';
import { CV_WRITER, cvWriterPrompt } from './prompts.js';

export const MAX_SAVES_PER_RUN = 3;

export interface WriterTask {
  jobId: string;
  /** Version to revise; omit for a fresh draft. */
  basedOnVersion?: number;
  /** The user's feedback, verbatim. */
  feedback?: string;
  /** Anything else the coordinator wants the writer to know. */
  notes?: string;
}

export interface WriterOutcome {
  runId: string;
  /** The last version saved in this run, if any. */
  version?: CvVersion;
  savedVersions: number[];
  reply: string;
}

export interface CvWriterDeps {
  store: CvStore;
  client: ChatClient;
  model: string;
  think?: Think;
  sessionId?: string;
  onEvent?: (event: AgentEvent) => void;
  /** Shared token meter for the whole app session. */
  usage?: Usage;
  today?: string;
  maxSteps?: number;
}

/** Tells the writer plainly whether another save is worthwhile, so it doesn't polish a clean draft. */
export function nextStep(version: CvVersion, savesLeft: number): string {
  const { passed, issues } = version.verification;
  if (passed && issues.length === 0) return 'All checks passed. Do not save again; reply to the coordinator now.';
  if (savesLeft === 0) return 'No saves left. Reply to the coordinator, mentioning any issues that remain.';
  if (!passed) return 'Fix every error, then save again.';
  return 'Only warnings remain. Save again only if you can fix some without inventing facts; otherwise reply to the coordinator, mentioning them.';
}

const json = (value: unknown) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';

/** Everything the writer needs, up front, so it can draft without extra lookups. */
export function writerBrief(task: WriterTask, job: JobListing, profile: Profile, base?: CvVersion): string {
  const parts = [
    base
      ? `# Task\nRevise CV version ${base.version} for job "${job.id}" (${job.title} at ${job.company}).`
      : `# Task\nWrite a CV for job "${job.id}" (${job.title} at ${job.company}).`,
  ];
  if (task.feedback) parts.push(`## Feedback to address (the candidate's words)\n${task.feedback}`);
  if (task.notes) parts.push(`## Notes from the coordinator\n${task.notes}`);
  const { id: _id, createdAt: _createdAt, ...listing } = job;
  parts.push(`# Job listing\n${json(listing)}`);
  const { revision, updatedAt: _updatedAt, ...facts } = profile;
  parts.push(`# Candidate profile (revision ${revision})\n${json(facts)}`);
  if (base) {
    parts.push(`# Version ${base.version} (the one to revise)\n${json(base.document)}`);
    const issues = base.verification.issues.map((i) => `- ${i.severity}: ${i.message}`);
    if (issues.length) parts.push(`Its verification report:\n${issues.join('\n')}`);
  }
  return parts.join('\n\n');
}

/**
 * Runs the cv-writer: a separate agent, with its own prompt, model and context, whose
 * only capability is saving verified CV versions. Every run is stored for auditing.
 */
export async function runCvWriter(task: WriterTask, deps: CvWriterDeps): Promise<WriterOutcome> {
  const { store } = deps;
  const job = await store.getJob(task.jobId);
  if (!job) throw new Error(`No job listing "${task.jobId}"`);
  const base = task.basedOnVersion ? await store.getCvVersion(task.jobId, task.basedOnVersion) : undefined;
  if (task.basedOnVersion && !base) throw new Error(`Version ${task.basedOnVersion} does not exist for job "${task.jobId}"`);
  const profile = await store.getProfile();

  const runId = store.newId('run');
  const saved: CvVersion[] = [];

  const saveCvVersion = defineTool({
    name: 'save_cv_version',
    description:
      'Save the complete CV as a new version. It is verified against the profile and job; the response gives the version number and any issues to fix.',
    parameters: z.object({
      document: CvDocumentSchema,
      changeSummary: z.string().min(1).describe('What this version does and why: tailoring choices, changes from the version it revises'),
    }),
    async run({ document, changeSummary }) {
      if (saved.length >= MAX_SAVES_PER_RUN) {
        throw new Error(`You have already saved ${MAX_SAVES_PER_RUN} versions in this task. Stop and reply to the coordinator.`);
      }
      const current = await store.getProfile();
      const basedOnVersion = saved.at(-1)?.version ?? task.basedOnVersion;
      const version = await store.saveCvVersion({
        jobId: job.id,
        profileRevision: current.revision,
        changeSummary,
        document,
        markdown: renderMarkdown(document),
        verification: verifyCv(document, current, job),
        writerRunId: runId,
        ...(basedOnVersion ? { basedOnVersion } : {}),
        ...(task.feedback ? { feedback: task.feedback } : {}),
      });
      saved.push(version);
      const savesLeft = MAX_SAVES_PER_RUN - saved.length;
      return {
        version: version.version,
        verificationPassed: version.verification.passed,
        issues: version.verification.issues,
        keywordCoverage: version.verification.keywordCoverage,
        stats: version.verification.stats,
        savesLeft,
        nextStep: nextStep(version, savesLeft),
      };
    },
  });

  const usage = emptyUsage();
  const agent = new Agent({
    name: CV_WRITER,
    model: deps.model,
    client: deps.client,
    systemPrompt: cvWriterPrompt(deps.today ?? new Date().toDateString()),
    tools: [saveCvVersion],
    maxSteps: deps.maxSteps ?? 8,
    audit: (event) => store.audit(event),
    usage,
    ...(deps.think !== undefined ? { think: deps.think } : {}),
    ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
  });

  const startedAt = store.timestamp();
  const record = async (outcome: 'saved' | 'no-cv' | 'failed', reply: string, error?: string) => {
    await store.saveWriterRun({
      id: runId,
      ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
      jobId: job.id,
      model: deps.model,
      startedAt,
      finishedAt: store.timestamp(),
      outcome,
      savedVersions: saved.map((v) => v.version),
      reply,
      ...(error ? { error } : {}),
      systemPrompt: agent.systemPrompt,
      messages: agent.messages,
      usage,
    });
    if (deps.usage) {
      deps.usage.requests += usage.requests;
      deps.usage.promptTokens += usage.promptTokens;
      deps.usage.outputTokens += usage.outputTokens;
    }
  };

  let reply: string;
  try {
    reply = (await agent.run(writerBrief(task, job, profile, base))).reply;
    if (saved.length === 0) {
      reply = (await agent.run('You have not saved a CV yet. Call save_cv_version now with the complete document.')).reply;
    }
    await record(saved.length ? 'saved' : 'no-cv', reply);
  } catch (err) {
    const message = (err as Error).message;
    // A draft that was already saved is still worth showing; only fail outright with nothing to show.
    await record(saved.length ? 'saved' : 'failed', '', message);
    if (!saved.length) throw err;
    reply = `(The writer stopped early after saving: ${message})`;
  }

  const version = saved.at(-1);
  return { runId, savedVersions: saved.map((v) => v.version), reply, ...(version ? { version } : {}) };
}
