import { z } from 'zod';
import { runChecks } from '../cv/checks.ts';
import { summariseCritique } from '../cv/critique.ts';
import { htmlToText, wordCount } from '../util/text.ts';
import { applyEdit, describeCv, formatFindings, readProfileTool, skillTools } from './commonTools.ts';
import { pageCountFor, runCritic } from './critic.ts';
import type { AgentDeps } from './deps.ts';
import { noopEmit, type Emit } from './events.ts';
import { runAgent } from './loop.ts';
import { WRITER_PROMPT } from './prompts.ts';
import { defineTool, ToolError, type AgentTool } from './tool.ts';

export interface WriterOptions {
  jobId: string;
  /** What the coordinator wants done, e.g. "Draft a first version emphasising stakeholder work". */
  instructions: string;
  emit?: Emit;
  signal?: AbortSignal;
  /** Maximum critic calls the writer may make during one run. */
  maxCritiques?: number;
}

export interface WriterResult {
  report: string;
  /** Whether the CV was saved during this run. */
  changed: boolean;
  words: number;
}

export async function buildWriterSystemPrompt(deps: AgentDeps): Promise<string> {
  const autoloaded = await deps.skills.autoloaded('writer');
  const index = await deps.skills.index('writer');
  return [
    WRITER_PROMPT,
    ...autoloaded.map((s) => `\n---\n# Skill: ${s.name}\n${s.body}`),
    `\n---\n# Other skills you can read with read_skill\n${index}`,
  ].join('\n');
}

export function writerTools(deps: AgentDeps, opts: WriterOptions, state: { changed: boolean; critiques: number }): AgentTool[] {
  const { store } = deps;
  const { jobId } = opts;
  const emit = opts.emit ?? noopEmit;

  const afterSave = async (html: string) => {
    state.changed = true;
    emit({ type: 'artifact', kind: 'cv', jobId });
    const findings = runChecks(html, { profile: await store.readProfile() });
    return `Saved (${wordCount(htmlToText(html))} words).\n${formatFindings(findings)}`;
  };

  return [
    readProfileTool(store),
    defineTool({
      name: 'read_job',
      description: 'Read the job listing this CV targets.',
      schema: z.object({}),
      async run() {
        const job = await store.requireJob(jobId);
        return `# ${job.title} — ${job.company}\n\n${job.listing}`;
      },
    }),
    defineTool({
      name: 'read_cv',
      description: 'Read the current CV. Use format "html" before edit_cv so your find text matches exactly.',
      schema: z.object({ format: z.enum(['html', 'text']).default('html') }),
      async run({ format }) {
        return describeCv(store, jobId, format);
      },
    }),
    defineTool({
      name: 'write_cv',
      description: 'Save the complete CV as an HTML body fragment following the HTML contract. Replaces the whole CV.',
      schema: z.object({ html: z.string().min(1).describe('The complete CV HTML fragment') }),
      async run({ html }) {
        const saved = await store.writeCv(jobId, html, 'writer');
        return afterSave(saved);
      },
    }),
    defineTool({
      name: 'edit_cv',
      description: 'Make a targeted change to the CV HTML by exact find/replace. Use read_cv (html) first.',
      schema: z.object({
        find: z.string().describe('Exact existing HTML to replace (must be unique unless replace_all)'),
        replace: z.string().describe('Replacement HTML'),
        replace_all: z.boolean().optional(),
      }),
      async run({ find, replace, replace_all }) {
        const current = await store.readCv(jobId);
        if (!current?.trim()) throw new ToolError('There is no CV yet — use write_cv.');
        const saved = await store.writeCv(jobId, applyEdit(current, find, replace, replace_all), 'writer');
        return afterSave(saved);
      },
    }),
    defineTool({
      name: 'check_pages',
      description: 'Render the CV to PDF with its stylesheet and report the page count.',
      schema: z.object({}),
      async run() {
        const pages = await pageCountFor(deps, jobId);
        return pages === undefined ? 'Page count unavailable.' : `The CV renders to ${pages} page(s).`;
      },
    }),
    defineTool({
      name: 'request_critique',
      description: 'Ask the CV critic for an independent assessment of the saved CV (score, coverage, mistakes, factual issues).',
      schema: z.object({ focus: z.string().optional().describe('What the critic should pay particular attention to') }),
      async run({ focus }) {
        if (state.critiques >= (opts.maxCritiques ?? 1)) {
          throw new ToolError('Critique limit reached for this task. Finish with your report.');
        }
        state.critiques++;
        const critique = await runCritic(deps, { jobId, focus, emit, signal: opts.signal });
        return summariseCritique(critique);
      },
    }),
    ...skillTools(deps.skills, 'writer'),
  ];
}

export async function buildWriterTask(deps: AgentDeps, opts: WriterOptions): Promise<string> {
  const { store } = deps;
  const job = await store.requireJob(opts.jobId);
  const profile = await store.readProfile();
  const cv = await store.readCv(opts.jobId);
  const critique = await store.latestCritique(opts.jobId);
  return [
    `# Task from the coordinator\n${opts.instructions.trim()}`,
    `# Job listing: ${job.title} — ${job.company}\n${job.listing.trim() || '(empty)'}`,
    `# Candidate profile (the only source of facts)\n${profile.trim() || '(The profile is empty.)'}`,
    cv?.trim() ? `# Current CV (HTML)\n${cv}` : '# Current CV\n(none yet — write the first version with write_cv)',
    critique ? `# Latest critique\n${summariseCritique(critique)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Runs the writer subagent: drafts or edits the CV for one job and reports back. */
export async function runWriter(deps: AgentDeps, opts: WriterOptions): Promise<WriterResult> {
  const state = { changed: false, critiques: 0 };
  const result = await runAgent({
    agent: 'writer',
    model: deps.models.writer,
    system: await buildWriterSystemPrompt(deps),
    history: [{ role: 'user', content: await buildWriterTask(deps, opts) }],
    tools: writerTools(deps, opts, state),
    maxSteps: 14,
    emit: opts.emit,
    signal: opts.signal,
  });
  const cv = (await deps.store.readCv(opts.jobId)) ?? '';
  return {
    report: result.finalText.trim() || (state.changed ? 'CV updated.' : 'No changes were made.'),
    changed: state.changed,
    words: wordCount(htmlToText(cv)),
  };
}
