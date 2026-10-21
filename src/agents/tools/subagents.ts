import { z } from 'zod';
import { defineTool } from '../types';

export const callWriter = defineTool({
  name: 'callWriter',
  description:
    'Delegate CV drafting or revision to the writer subagent. The writer receives the job posting and CV preferences ' +
    'automatically, can read the profile, edits the CV HTML and CSS, may ask the critic for review, and returns a report. ' +
    'Save any preference changes with editPreferences first. Give a precise brief: what to write or change, what to emphasise, ' +
    'and any user feedback verbatim.',
  schema: z.object({
    jobId: z.string().describe('Job whose CV to write'),
    instructions: z.string().min(1).describe('Brief for the writer'),
  }),
  async run({ jobId, instructions }, ctx) {
    const store = ctx.deps.store;
    const job = await store.requireJob(ctx.userId, jobId);
    const prefs = await store.getPreferences(ctx.userId, jobId);
    const { id, title, company, location, url, description, notes } = job;
    const brief = [
      `## Brief from the coordinator`,
      instructions,
      `## Target job (jobId: ${jobId})`,
      JSON.stringify({ id, title, company, location, url, notes, description }, null, 2),
      `## CV preferences`,
      JSON.stringify(prefs, null, 2),
    ].join('\n\n');
    const report = await ctx.spawn('writer', brief);
    return { agent: 'writer', jobId, report };
  },
});

export const callCritic = defineTool({
  name: 'callCritic',
  description:
    'Ask the critic subagent to review a CV against its job posting. The user\'s profile is passed along so the critic ' +
    'can flag unsupported claims. Returns a scored critique with prioritised, concrete fixes. Optionally narrow the review with `focus`.',
  schema: z.object({
    jobId: z.string().describe('Job whose CV to review'),
    focus: z.string().optional().describe('What to focus on, e.g. "ATS keywords" or "the summary section"'),
  }),
  async run({ jobId, focus }, ctx) {
    await ctx.deps.store.requireJob(ctx.userId, jobId);
    const profile = await ctx.deps.store.getProfile(ctx.userId);
    const brief = [
      `Review the CV for jobId ${jobId} against its job posting.`,
      focus ? `Focus: ${focus}` : 'Give a complete review.',
      `Requested by: ${ctx.agent}.`,
      `## User profile (the only evidence of what is true)`,
      JSON.stringify(profile, null, 2),
    ].join('\n');
    const critique = await ctx.spawn('critic', brief);
    return { agent: 'critic', jobId, critique };
  },
});
