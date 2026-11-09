import { z } from 'zod';
import { defineTool, ToolError } from './types.js';

export const callWriter = defineTool({
  name: 'callWriter',
  description:
    'Delegate CV writing to the Writer subagent. It reads the profile, job and preferences, writes/edits the CV HTML and CSS, ' +
    'may consult the Critic, and returns a report. Give precise instructions: what to create or change, what to emphasise, ' +
    'anything the user asked for. Can take a few minutes.',
  schema: z.object({
    jobId: z.string().optional().describe('Job whose CV to write. Defaults to the job in focus.'),
    instructions: z.string().min(1).describe('What the writer should do, including user requests and context from the chat.'),
  }),
  async run({ jobId, instructions }, ctx) {
    const id = jobId || ctx.focusJobId;
    if (!id) throw new ToolError('jobId is required (no job in focus). Create the job with editJob first.');
    await ctx.repo.getJob(ctx.userId, id).catch(() => {
      throw new ToolError(`Job ${id} not found`);
    });
    const task = `Job ID: ${id}\n\nInstructions from the Coordinator:\n${instructions}`;
    return ctx.callAgent('writer', task, { jobId: id, callId: ctx.callId });
  },
});

export const callCritic = defineTool({
  name: 'callCritic',
  description:
    "Ask the Critic subagent for an independent review of a job's current CV against the job and the CV preferences. " +
    'Returns a score out of 10, strengths, must-fix issues with concrete rewrites, and missing information.',
  schema: z.object({
    jobId: z.string().optional().describe('Job whose CV to review. Defaults to the job in focus.'),
    focus: z.string().optional().describe('Optional: what to pay special attention to.'),
  }),
  async run({ jobId, focus }, ctx) {
    const id = jobId || ctx.focusJobId;
    if (!id) throw new ToolError('jobId is required (no job in focus).');
    const cv = await ctx.repo.getCv(ctx.userId, id).catch(() => {
      throw new ToolError(`Job ${id} not found`);
    });
    if (!cv.html.trim()) throw new ToolError('This job has no CV yet — ask the writer to create one first.');
    const task = `Job ID: ${id}\n\nReview request from the ${ctx.agent === 'writer' ? 'Writer' : 'Coordinator'}: ` +
      (focus?.trim() || 'Give a complete review of the current CV.');
    return ctx.callAgent('critic', task, { jobId: id, callId: ctx.callId });
  },
});
