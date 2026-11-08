import { z } from 'zod';
import { defineTool, ToolError, type ToolContext } from '../tool.js';

async function requireJob(ctx: ToolContext, jobId: string | undefined) {
  const id = jobId ?? ctx.boundJobId;
  if (!id) throw new ToolError('jobId is required. Call readJob without arguments to list jobs.');
  const job = await ctx.services.repo.getJob(ctx.userId, id);
  if (!job) throw new ToolError(`No job found with id "${id}".`);
  return job;
}

export const callWriter = defineTool({
  name: 'callWriter',
  description:
    'Delegate CV writing to the Writer subagent. It reads the profile, job, preferences, current CV and CSS, writes/updates the CV HTML and CSS, gets it critiqued, and returns a summary plus any missing information. Give precise instructions (what to write or change and why, user feedback verbatim).',
  schema: z.object({
    jobId: z.string().describe('Job whose CV should be written or revised'),
    instructions: z.string().min(5).describe('What the Writer should do, including relevant user feedback and constraints'),
  }),
  async run({ jobId, instructions }, ctx) {
    const job = await requireJob(ctx, jobId);
    const res = await ctx.services.runSubagent('writer', {
      userId: ctx.userId,
      jobId: job.id,
      task: instructions,
      parentRunId: ctx.runId,
      emit: ctx.emit,
      signal: ctx.signal,
      timezone: ctx.timezone,
    });
    if (!res.ok) throw new ToolError(`Writer did not complete: ${res.result}`);
    return { writerRunId: res.runId, report: res.result };
  },
});

/** A writer run may request at most this many critiques before it must report back. */
export const MAX_CRITIQUES_PER_WRITER_RUN = 2;

export const callCritic = defineTool({
  name: 'callCritic',
  description:
    'Ask the Critic subagent for an independent review of the CV for a job against the job description and preferences. Returns a score, verdict and prioritised, actionable issues.',
  schema: z.object({
    jobId: z.string().optional().describe('Job whose CV to review (the Writer defaults to its assigned job)'),
    focus: z.string().optional().describe('Optional focus, e.g. "check the summary and keyword coverage"'),
  }),
  async run({ jobId, focus }, ctx) {
    const used = ctx.counters.get('critiques') ?? 0;
    if (ctx.agent === 'writer' && used >= MAX_CRITIQUES_PER_WRITER_RUN) {
      throw new ToolError(
        `Critique limit reached (${MAX_CRITIQUES_PER_WRITER_RUN} per task). Finish now and list any remaining issues in your report to the Coordinator.`,
      );
    }
    ctx.counters.set('critiques', used + 1);
    const job = await requireJob(ctx, jobId);
    const task = focus?.trim() ? `Review the CV. Focus requested by the ${ctx.agent}: ${focus.trim()}` : 'Review the CV.';
    const res = await ctx.services.runSubagent('critic', {
      userId: ctx.userId,
      jobId: job.id,
      task,
      parentRunId: ctx.runId,
      emit: ctx.emit,
      signal: ctx.signal,
      timezone: ctx.timezone,
    });
    if (!res.ok) throw new ToolError(`Critic did not complete: ${res.result}`);
    return { criticRunId: res.runId, critique: res.result };
  },
});
