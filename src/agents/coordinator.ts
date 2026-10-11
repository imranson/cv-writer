import { z } from 'zod';
import { buildCvDocument } from '../cv/document.ts';
import { runChecks } from '../cv/checks.ts';
import { summariseCritique } from '../cv/critique.ts';
import { getPreset, STYLE_PRESETS } from '../cv/styles.ts';
import type { Session } from '../storage/store.ts';
import { hashText, htmlToText, truncate, wordCount } from '../util/text.ts';
import { applyEdit, describeCv, formatFindings, readProfileTool, skillTools } from './commonTools.ts';
import { runCritic } from './critic.ts';
import type { AgentDeps } from './deps.ts';
import type { Emit } from './events.ts';
import { defineTool, ToolError, type AgentTool } from './tool.ts';
import { COORDINATOR_PROMPT } from './prompts.ts';
import { runWriter } from './writer.ts';

/** Mutable per-turn state shared between the coordinator's tools and the session. */
export interface CoordinatorState {
  jobId: string | null;
}

export interface CoordinatorToolOptions {
  emit: Emit;
  signal?: AbortSignal;
}

function headings(markdown: string): string[] {
  return [...markdown.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => (m[1] ?? '').trim());
}

/** Snapshot of the workspace so the coordinator always knows where the user is in the journey. */
export async function describeState(deps: AgentDeps, session: Pick<Session, 'jobId' | 'summary'>): Promise<string> {
  const { store } = deps;
  const profile = await store.readProfile();
  const jobs = await store.listJobs();
  const lines: string[] = [`Today: ${(deps.now?.() ?? new Date()).toISOString().slice(0, 10)}`];

  if (!profile.trim()) {
    lines.push('Profile: EMPTY — start by interviewing the user to build it.');
  } else {
    const hs = headings(profile);
    lines.push(`Profile: ${wordCount(profile)} words. Headings: ${hs.length ? hs.join(' | ') : '(none)'}`);
    if (!/^#+\s*preferences/im.test(profile)) lines.push('Profile has no "Preferences" section yet.');
  }

  if (jobs.length) {
    lines.push('Saved jobs:');
    for (const j of jobs) {
      const cv = j.hasCv ? `CV: yes${j.score !== undefined ? `, last score ${j.score} (${j.verdict})${j.critiqueStale ? ' — CV changed since' : ''}` : ', not critiqued'}` : 'CV: none';
      lines.push(`- ${j.id}: ${j.title} — ${j.company} (${cv})`);
    }
  } else {
    lines.push('Saved jobs: none.');
  }

  if (session.jobId) {
    const job = await store.getJob(session.jobId);
    if (job) {
      const cv = await store.readCv(job.id);
      const critique = await store.latestCritique(job.id);
      lines.push(`ACTIVE JOB: ${job.id} — ${job.title} at ${job.company}`);
      if (cv?.trim()) {
        lines.push(`Active CV: ${wordCount(htmlToText(cv))} words.`);
        if (critique) {
          const stale = critique.cvHash !== hashText(cv);
          lines.push(`Latest critique: ${critique.score}/100, verdict ${critique.verdict}${stale ? ' (the CV has changed since — re-critique before calling it ready)' : ''}.`);
        } else {
          lines.push('The active CV has not been critiqued yet.');
        }
      } else {
        lines.push('No CV written for the active job yet.');
      }
    }
  } else {
    lines.push('ACTIVE JOB: none selected for this conversation.');
  }

  if (session.summary.trim()) lines.push(`\nSummary of earlier conversation (older messages were compacted):\n${session.summary.trim()}`);
  return lines.join('\n');
}

export async function buildCoordinatorSystemPrompt(deps: AgentDeps, session: Pick<Session, 'jobId' | 'summary'>): Promise<string> {
  const autoloaded = await deps.skills.autoloaded('coordinator');
  return [
    COORDINATOR_PROMPT,
    ...autoloaded.map((s) => `\n---\n# Skill: ${s.name}\n${s.body}`),
    `\n---\n# Skills you can read with read_skill\n${await deps.skills.index('coordinator')}`,
    `\n---\n# Current state\n${await describeState(deps, session)}`,
  ].join('\n');
}

const jobIdArg = z.string().optional().describe('Job id; defaults to the active job');

export function coordinatorTools(deps: AgentDeps, state: CoordinatorState, opts: CoordinatorToolOptions): AgentTool[] {
  const { store } = deps;
  const { emit, signal } = opts;

  const resolveJob = async (jobId?: string) => {
    const id = jobId?.trim() || state.jobId;
    if (!id) throw new ToolError('No active job. Ask the user for the job listing and call save_job, or call set_active_job.');
    const job = await store.getJob(id);
    if (!job) throw new ToolError(`Job "${id}" not found. Call list_jobs to see saved jobs.`);
    return job;
  };

  const setActive = (jobId: string) => {
    state.jobId = jobId;
    emit({ type: 'artifact', kind: 'session', jobId });
  };

  const tools: AgentTool[] = [
    readProfileTool(store),
    defineTool({
      name: 'update_profile',
      description:
        'Replace the whole candidate profile with new markdown. Read it first and keep everything still true — this overwrites. Prefer edit_profile for small changes.',
      schema: z.object({
        markdown: z.string().min(1),
        allow_shrink: z.boolean().optional().describe('Set true only when deliberately removing a lot of content'),
      }),
      async run({ markdown, allow_shrink }) {
        const current = await store.readProfile();
        if (!allow_shrink && current.length > 400 && markdown.length < current.length * 0.6) {
          throw new ToolError(
            `The new profile is much shorter (${markdown.length} vs ${current.length} characters) and would lose information. Use edit_profile, include all existing content, or set allow_shrink if the user asked to remove it.`,
          );
        }
        await store.writeProfile(markdown);
        emit({ type: 'artifact', kind: 'profile' });
        return `Profile saved (${wordCount(markdown)} words).`;
      },
    }),
    defineTool({
      name: 'edit_profile',
      description:
        'Edit the profile by exact find/replace. To append to a section, find its last line and replace it with that line plus the new text. If the profile is empty use update_profile.',
      schema: z.object({
        find: z.string().describe('Exact existing text'),
        replace: z.string(),
        replace_all: z.boolean().optional(),
      }),
      async run({ find, replace, replace_all }) {
        const current = await store.readProfile();
        await store.writeProfile(applyEdit(current, find, replace, replace_all));
        emit({ type: 'artifact', kind: 'profile' });
        return 'Profile updated.';
      },
    }),
    defineTool({
      name: 'list_jobs',
      description: 'List saved job listings with their CV status and latest critique score.',
      schema: z.object({}),
      async run() {
        const jobs = await store.listJobs();
        if (!jobs.length) return 'No jobs saved yet.';
        return jobs
          .map((j) => `- ${j.id}: ${j.title} — ${j.company}${j.id === state.jobId ? ' [active]' : ''} | CV: ${j.hasCv ? 'yes' : 'no'}${j.score !== undefined ? ` | score ${j.score} (${j.verdict})` : ''}`)
          .join('\n');
      },
    }),
    defineTool({
      name: 'read_job',
      description: 'Read a saved job listing.',
      schema: z.object({ job_id: jobIdArg }),
      async run({ job_id }) {
        const job = await resolveJob(job_id);
        return `# ${job.title} — ${job.company} (id: ${job.id})${job.url ? `\nURL: ${job.url}` : ''}\n\n${job.listing}`;
      },
    }),
    defineTool({
      name: 'save_job',
      description: 'Save a new job listing (full text as markdown) and make it the active job for this conversation.',
      schema: z.object({
        title: z.string().min(1).describe('Job title'),
        company: z.string().min(1).describe('Employer name'),
        listing: z.string().min(1).describe('The full job listing text, as markdown'),
        url: z.string().optional(),
      }),
      async run(input) {
        const job = await store.createJob(input);
        setActive(job.id);
        emit({ type: 'artifact', kind: 'job', jobId: job.id });
        return `Saved job "${job.title}" at ${job.company} with id ${job.id}. It is now the active job.`;
      },
    }),
    defineTool({
      name: 'update_job',
      description: 'Update a saved job listing (title, company, url or listing text).',
      schema: z.object({
        job_id: jobIdArg,
        title: z.string().optional(),
        company: z.string().optional(),
        listing: z.string().optional(),
        url: z.string().optional(),
      }),
      async run({ job_id, ...patch }) {
        const job = await resolveJob(job_id);
        await store.updateJob(job.id, patch);
        emit({ type: 'artifact', kind: 'job', jobId: job.id });
        return `Job ${job.id} updated.`;
      },
    }),
    defineTool({
      name: 'set_active_job',
      description: 'Make a saved job the active job for this conversation (the CV being worked on).',
      schema: z.object({ job_id: z.string() }),
      async run({ job_id }) {
        const job = await resolveJob(job_id);
        setActive(job.id);
        return `Active job is now ${job.id}: ${job.title} — ${job.company}.`;
      },
    }),
    defineTool({
      name: 'write_cv',
      description:
        'Delegate to the CV Writer subagent to draft or revise the CV for a job. Give specific instructions (emphasis, fixes, cuts, preferences). Returns the writer\'s report.',
      schema: z.object({
        instructions: z.string().min(1).describe('What the writer should do'),
        job_id: jobIdArg,
      }),
      async run({ instructions, job_id }) {
        const job = await resolveJob(job_id);
        const result = await runWriter(deps, { jobId: job.id, instructions, emit, signal });
        return `${result.changed ? `CV saved (${result.words} words).` : 'The CV was not changed.'}\nWriter report:\n${result.report}`;
      },
    }),
    defineTool({
      name: 'critique_cv',
      description:
        'Delegate to the CV Critic subagent: grades the CV against the job (0-100 + verdict), checks for mistakes and verifies claims against the profile.',
      schema: z.object({
        focus: z.string().optional().describe('Anything the critic should pay particular attention to'),
        job_id: jobIdArg,
      }),
      async run({ focus, job_id }) {
        const job = await resolveJob(job_id);
        const critique = await runCritic(deps, { jobId: job.id, focus, emit, signal });
        return summariseCritique(critique);
      },
    }),
    defineTool({
      name: 'read_cv',
      description: 'Read the current CV for a job (plain text by default, or the raw HTML).',
      schema: z.object({ job_id: jobIdArg, format: z.enum(['text', 'html']).default('text') }),
      async run({ job_id, format }) {
        const job = await resolveJob(job_id);
        return describeCv(store, job.id, format);
      },
    }),
    defineTool({
      name: 'read_style',
      description: "Read the CV's stylesheet (CSS) and the available style presets.",
      schema: z.object({ job_id: jobIdArg }),
      async run({ job_id }) {
        const job = await resolveJob(job_id);
        const presets = STYLE_PRESETS.map((p) => `- ${p.id}: ${p.description}`).join('\n');
        return `Presets:\n${presets}\n\nCurrent CSS:\n${await store.readStyle(job.id)}`;
      },
    }),
    defineTool({
      name: 'set_style',
      description:
        'Change the CV styling: apply a preset ("classic", "modern", "compact") and/or replace the stylesheet with new CSS (read_style first; keep the @page rule). The user can also edit the CSS directly in the side panel.',
      schema: z.object({
        preset: z.string().optional(),
        css: z.string().optional().describe('Complete replacement stylesheet'),
        job_id: jobIdArg,
      }),
      async run({ preset, css, job_id }) {
        const job = await resolveJob(job_id);
        if (!preset && !css) throw new ToolError('Provide a preset or css.');
        let next = css;
        if (!next && preset) {
          const p = getPreset(preset);
          if (!p) throw new ToolError(`Unknown preset "${preset}". Options: ${STYLE_PRESETS.map((x) => x.id).join(', ')}`);
          next = p.css;
        }
        await store.writeStyle(job.id, next!);
        emit({ type: 'artifact', kind: 'style', jobId: job.id });
        return 'Style updated.';
      },
    }),
    defineTool({
      name: 'export_pdf',
      description:
        'Render the final PDF, check page count and run automated checks. Returns a readiness report and the download link to give the user.',
      schema: z.object({ job_id: jobIdArg }),
      async run({ job_id }) {
        const job = await resolveJob(job_id);
        const html = await store.readCv(job.id);
        if (!html?.trim()) throw new ToolError('There is no CV for this job yet.');
        let pageCount: number | undefined;
        if (deps.pdf) {
          const rendered = await deps.pdf.render(buildCvDocument({ html, css: await store.readStyle(job.id) }));
          pageCount = rendered.pageCount;
        }
        const findings = runChecks(html, { profile: await store.readProfile(), pageCount });
        const critique = await store.latestCritique(job.id);
        const critiqueLine = critique
          ? `Latest critique: ${critique.score}/100 (${critique.verdict})${critique.cvHash !== hashText(html) ? ' — made before the latest changes; consider re-critiquing' : ''}.`
          : 'No critique yet — run critique_cv before calling the CV ready.';
        const blocking = findings.some((f) => f.severity === 'error');
        return [
          pageCount !== undefined ? `PDF rendered: ${pageCount} page(s).` : 'PDF renderer unavailable.',
          formatFindings(findings),
          critiqueLine,
          blocking ? 'NOT READY: fix the errors above first.' : 'No blocking problems found by automated checks.',
          `Download link (give this to the user as a markdown link): /api/jobs/${job.id}/pdf?download=1`,
        ].join('\n');
      },
    }),
    ...skillTools(deps.skills, 'coordinator'),
  ];

  if (deps.fetchPage) {
    const fetchPage = deps.fetchPage;
    tools.push(
      defineTool({
        name: 'fetch_url',
        description: 'Fetch a web page (e.g. a job listing URL the user gave) and return its text.',
        schema: z.object({ url: z.string().describe('http(s) URL') }),
        async run({ url }) {
          const page = await fetchPage(url);
          const text = page.text.trim();
          if (text.length < 200) {
            return `The page returned very little text (it may need a login or JavaScript). Ask the user to paste the listing.\n\n${text}`;
          }
          return `Title: ${page.title}\nURL: ${page.url}\n\n${truncate(text, 15_000)}`;
        },
      }),
    );
  }
  return tools;
}
