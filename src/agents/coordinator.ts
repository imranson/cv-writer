import { z } from 'zod';
import { checkCv, formatChecks } from '../cv/checks.js';
import { exportCv } from '../cv/export.js';
import type { PdfRenderer } from '../cv/pdf.js';
import { describeStyle, FONTS, mergeStyle, STYLE_PRESETS, stylePatchShape } from '../cv/style.js';
import * as P from '../domain/profile.js';
import { ENTRY_SECTIONS, type ChatMessage, type CvVersion, type Job, type Profile, type Session } from '../domain/schemas.js';
import type { ChatModel, Think } from '../llm/types.js';
import type { Store } from '../storage/store.js';
import type { FetchedPage } from '../util/fetchPage.js';
import { truncate } from '../util/text.js';
import { defineTool, runAgent, ToolError, type Emit, type Tool } from './agent.js';
import { runCritic, summariseCritique } from './critic.js';
import { COORDINATOR_RULES } from './prompts.js';
import { runWriter } from './writer.js';

export interface AppDeps {
  store: Store;
  llm: ChatModel;
  models: { coordinator: string; writer: string; critic: string };
  think?: Partial<Record<'coordinator' | 'writer' | 'critic', Think>>;
  pdf?: PdfRenderer;
  fetchPage?: (url: string) => Promise<FetchedPage>;
  now?: () => Date;
}

/** Mutable per-turn context shared by the coordinator's tools. */
export interface TurnContext {
  session: Session;
  emit: Emit;
  /** Pages fetched this session, by URL, so a listing is stored verbatim without the model retyping it. */
  fetched: Map<string, FetchedPage>;
  /** Writer runs started this turn: one per turn keeps the user in the loop (and turns short). */
  writerRuns?: number;
}

export const MAX_WRITER_RUNS_PER_TURN = 1;

const LISTING_LIMIT = 8000;

/** The longest of the user's last three messages: where a pasted job listing will be. */
export function pastedText(session: Session): string | undefined {
  const recent = session.transcript.filter((t) => t.role === 'user').slice(-3);
  return recent.sort((a, b) => b.text.length - a.text.length)[0]?.text;
}

function versionLine(cv: CvVersion): string {
  const critique = cv.critiques.at(-1);
  return `- v${cv.version} (${cv.status}${cv.basedOnVersion ? `, revised from v${cv.basedOnVersion}` : ''}, ${cv.createdAt.slice(0, 16).replace('T', ' ')}) — checks: ${cv.checks.errorCount} errors, ${cv.checks.warningCount} warnings, ${cv.checks.wordCount} words; ${
    critique ? `critic ${critique.overallScore}/100 ${critique.verdict}` : 'not reviewed'
  }${cv.changeSummary ? `; "${truncate(cv.changeSummary, 160)}"` : ''}${cv.exports.at(-1)?.pdf ? `; PDF: ${cv.exports.at(-1)!.pdf} (${cv.exports.at(-1)!.pages ?? '?'} pages)` : ''}`;
}

export async function coordinatorState(deps: AppDeps, session: Session, now = new Date()): Promise<string> {
  const { store } = deps;
  const [profile, jobs, style] = await Promise.all([store.getProfile(), store.listJobs(), store.getStyle()]);
  const active = jobs.find((j) => j.id === session.activeJobId);
  const lines = [`# Live state (refreshed every turn). Today is ${now.toISOString().slice(0, 10)}.`, ''];

  lines.push(`## Profile (revision ${profile.revision})`, '```json', JSON.stringify({ ...profile, revision: undefined, updatedAt: undefined }), '```');
  const gaps = P.profileGaps(profile);
  lines.push('', '## Profile gaps to ask about (when relevant)', ...(gaps.length ? gaps.map((g) => `- ${g}`) : ['- none']));

  lines.push('', '## Saved job listings', ...(jobs.length ? jobs.map((j) => `- ${j.id === active?.id ? '[ACTIVE] ' : ''}${j.id}: ${j.title} at ${j.company} (saved ${j.createdAt.slice(0, 10)})`) : ['- none yet']));
  if (active) {
    lines.push(
      '',
      `## Active job: ${active.title} at ${active.company} (${active.id})`,
      [active.location, active.url].filter(Boolean).join(' · '),
      `Key requirements:\n${active.requirements.map((r) => `- ${r}`).join('\n') || '- none extracted'}`,
      `Keywords: ${active.keywords.join(', ') || 'none'}`,
      ...(active.notes ? [`Notes: ${active.notes}`] : []),
      'Listing text:',
      '"""',
      truncate(active.description, LISTING_LIMIT),
      '"""',
    );
    const versions = await store.listCvVersions(active.id);
    lines.push('', '## CV versions for the active job', ...(versions.length ? versions.map(versionLine) : ['- none yet']));
    const latest = versions.at(-1);
    if (latest) {
      const checks = checkCv(latest.document, profile, active);
      lines.push('', `## Automatic checks on v${latest.version} (against the current profile)`, formatChecks(checks));
      const reviewed = [...versions].reverse().find((v) => v.critiques.length);
      if (reviewed) lines.push('', `## Latest critic review (v${reviewed.version})`, summariseCritique(reviewed.critiques.at(-1)!));
    }
  }
  lines.push('', '## CV style', describeStyle(style), `PDF export: ${deps.pdf ? 'available' : 'unavailable (no Chrome found) — HTML and Markdown only'}`);
  return lines.join('\n');
}

const entryFields = {
  title: z.string().describe('Role, degree, project name, award name, ...'),
  organisation: z.string().optional().describe('Employer, university, client, issuer, ...'),
  location: z.string().optional(),
  startDate: z.string().optional().describe('As the user said it, e.g. "Sep 2021" or "2021"'),
  endDate: z.string().optional().describe('"Present" if ongoing'),
  summary: z.string().optional().describe('One or two sentences of context in the user’s words'),
};

const reason = z.string().optional().describe('Why — e.g. what the user said');

export function coordinatorTools(deps: AppDeps, ctx: TurnContext): Tool[] {
  const { store } = deps;
  const changed = (what: 'profile' | 'jobs' | 'cvs' | 'style' | 'session') => ctx.emit({ type: 'state', changed: [what] });

  const editProfile = async (operation: string, payload: Record<string, unknown>, apply: (p: Profile) => Profile) => {
    const { reason: why, ...rest } = payload;
    try {
      const profile = await store.updateProfile({ operation, actor: 'coordinator', ...(typeof why === 'string' ? { reason: why } : {}), payload: rest, apply });
      changed('profile');
      return profile;
    } catch (err) {
      if (err instanceof P.ProfileError) throw new ToolError(err.message);
      throw err;
    }
  };

  const activeJob = async (): Promise<Job> => {
    if (!ctx.session.activeJobId) throw new ToolError('No active job. Ask the user for the job listing and save it with save_job_listing (or pick one with set_active_job).');
    return store.getJob(ctx.session.activeJobId);
  };

  const getVersion = async (version: number) => {
    const job = await activeJob();
    try {
      return { job, cv: await store.getCvVersion(job.id, version) };
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
  };

  const criticDeps = {
    llm: deps.llm,
    model: deps.models.critic,
    ...(deps.think?.critic !== undefined ? { think: deps.think.critic } : {}),
  };

  return [
    // ---------- profile ----------
    defineTool({
      name: 'update_contact',
      description: 'Set contact details. Only the fields you pass change; links replaces the whole list.',
      schema: z.object({
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        location: z.string().optional().describe('City, country'),
        links: z.array(z.string()).optional().describe('LinkedIn, GitHub, portfolio... (full list)'),
        reason,
      }),
      mutates: true,
      label: () => 'Updating contact details',
      run: async (args) => {
        const { reason: _r, ...patch } = args;
        const p = await editProfile('update_contact', args, (p) => P.updateContact(p, patch));
        return { ok: true, contact: p.contact, revision: p.revision };
      },
    }),
    defineTool({
      name: 'set_career_goal',
      description: 'Record the user’s career goal / target roles in their words.',
      schema: z.object({ headline: z.string(), reason }),
      mutates: true,
      label: () => 'Saving career goal',
      run: async (args) => {
        const p = await editProfile('set_career_goal', args, (p) => P.setHeadline(p, args.headline));
        return { ok: true, headline: p.headline, revision: p.revision };
      },
    }),
    defineTool({
      name: 'add_profile_entry',
      description: 'Add a role, education, project, certification, award, publication or volunteering entry to the profile.',
      schema: z.object({
        section: z.enum(ENTRY_SECTIONS),
        ...entryFields,
        highlights: z.array(z.string()).optional().describe('Concrete achievements/responsibilities, one fact each, with numbers when known'),
        skills: z.array(z.string()).optional().describe('Technologies and skills used'),
        reason,
      }),
      mutates: true,
      label: (a) => `Adding ${a.section}: ${a.title}`,
      run: async (args) => {
        const { reason: _r, ...input } = args;
        let id = '';
        const p = await editProfile('add_entry', args, (p) => {
          const r = P.addEntry(p, input);
          id = r.entry.id;
          return r.profile;
        });
        return { ok: true, id, revision: p.revision };
      },
    }),
    defineTool({
      name: 'update_profile_entry',
      description: 'Change an existing profile entry. Use addHighlights to append achievements; highlights replaces them all.',
      schema: z.object({
        id: z.string(),
        section: z.enum(ENTRY_SECTIONS).optional(),
        ...entryFields,
        title: z.string().optional(),
        highlights: z.array(z.string()).optional(),
        addHighlights: z.array(z.string()).optional(),
        removeHighlights: z.array(z.union([z.string(), z.number()])).optional().describe('Exact text or 1-based position'),
        skills: z.array(z.string()).optional(),
        addSkills: z.array(z.string()).optional(),
        reason,
      }),
      mutates: true,
      label: (a) => `Updating ${a.id}`,
      run: async (args) => {
        const { id, reason: _r, ...patch } = args;
        let entry;
        const p = await editProfile('update_entry', args, (p) => {
          const r = P.updateEntry(p, id, patch);
          entry = r.entry;
          return r.profile;
        });
        return { ok: true, entry, revision: p.revision };
      },
    }),
    defineTool({
      name: 'remove_profile_entry',
      description: 'Delete a profile entry (only when the user asks or confirms).',
      schema: z.object({ id: z.string(), reason }),
      mutates: true,
      label: (a) => `Removing ${a.id}`,
      run: async (args) => {
        const p = await editProfile('remove_entry', args, (p) => P.removeEntry(p, args.id));
        return { ok: true, revision: p.revision };
      },
    }),
    defineTool({
      name: 'add_skills',
      description: 'Add skills to a category (created if new), e.g. "Languages", "Cloud", "Tools", "Spoken languages".',
      schema: z.object({ category: z.string(), items: z.array(z.string()).min(1), reason }),
      mutates: true,
      label: (a) => `Adding skills: ${a.items.join(', ')}`,
      run: async (args) => {
        const p = await editProfile('add_skills', args, (p) => P.addSkills(p, args.category, args.items));
        return { ok: true, skills: p.skills, revision: p.revision };
      },
    }),
    defineTool({
      name: 'remove_skills',
      description: 'Remove skills from the profile.',
      schema: z.object({ items: z.array(z.string()).min(1), reason }),
      mutates: true,
      label: (a) => `Removing skills: ${a.items.join(', ')}`,
      run: async (args) => {
        const p = await editProfile('remove_skills', args, (p) => P.removeSkills(p, args.items));
        return { ok: true, skills: p.skills, revision: p.revision };
      },
    }),
    defineTool({
      name: 'add_facts',
      description: 'Record other facts worth knowing: right to work, notice period, languages spoken, interests, preferences (e.g. "British spelling").',
      schema: z.object({ facts: z.array(z.string()).min(1), reason }),
      mutates: true,
      label: () => 'Saving facts',
      run: async (args) => {
        const p = await editProfile('add_facts', args, (p) => P.addFacts(p, args.facts));
        return { ok: true, facts: p.facts, revision: p.revision };
      },
    }),
    defineTool({
      name: 'remove_facts',
      description: 'Remove facts, by exact text or 1-based position.',
      schema: z.object({ facts: z.array(z.union([z.string(), z.number()])).min(1), reason }),
      mutates: true,
      label: () => 'Removing facts',
      run: async (args) => {
        const p = await editProfile('remove_facts', args, (p) => P.removeFacts(p, args.facts));
        return { ok: true, facts: p.facts, revision: p.revision };
      },
    }),

    // ---------- jobs ----------
    defineTool({
      name: 'fetch_job_listing',
      description: 'Fetch a job listing web page the user gave you. Read it, then call save_job_listing with listing_source "url".',
      schema: z.object({ url: z.string() }),
      label: (a) => `Fetching ${a.url}`,
      run: async ({ url }) => {
        if (!deps.fetchPage) throw new ToolError('Fetching pages is disabled. Ask the user to paste the listing.');
        let page: FetchedPage;
        try {
          page = await deps.fetchPage(url);
        } catch (err) {
          throw new ToolError(`Could not fetch the page: ${(err as Error).message}`);
        }
        ctx.fetched.set(url, page);
        return { url: page.url, title: page.title, company: page.company, location: page.location, text: truncate(page.text, 12_000) };
      },
    }),
    defineTool({
      name: 'save_job_listing',
      description:
        'Save a job listing and make it the active job. The full listing text is stored verbatim from its source: "pasted" = the user’s message containing the listing; "url" = the page you fetched with fetch_job_listing.',
      schema: z.object({
        title: z.string(),
        company: z.string(),
        location: z.string().optional(),
        url: z.string().optional(),
        listing_source: z.enum(['pasted', 'url']).default('pasted'),
        requirements: z.array(z.string()).describe('Key requirements, most important first (skills, experience, qualifications)'),
        keywords: z.array(z.string()).describe('Terms a recruiter or ATS will look for (technologies, methods, domain terms)'),
        notes: z.string().optional(),
      }),
      mutates: true,
      label: (a) => `Saving job: ${a.title} at ${a.company}`,
      run: async (args) => {
        let description: string | undefined;
        if (args.listing_source === 'url') {
          const page = args.url ? ctx.fetched.get(args.url) : [...ctx.fetched.values()].at(-1);
          if (!page) throw new ToolError('No fetched page for that URL. Call fetch_job_listing first.');
          description = page.text;
        } else {
          description = pastedText(ctx.session);
          if (!description || description.length < 200)
            throw new ToolError('I could not find a pasted listing in the user’s recent messages. Ask the user to paste the full listing (or give a URL).');
        }
        const job = await store.saveJob({
          title: args.title,
          company: args.company,
          description,
          requirements: args.requirements,
          keywords: args.keywords,
          ...(args.location ? { location: args.location } : {}),
          ...(args.url ? { url: args.url } : {}),
          ...(args.notes ? { notes: args.notes } : {}),
        });
        ctx.session.activeJobId = job.id;
        changed('jobs');
        return { ok: true, jobId: job.id, active: true, storedCharacters: description.length };
      },
    }),
    defineTool({
      name: 'update_job_listing',
      description: 'Refine the active job’s extracted requirements, keywords or notes.',
      schema: z.object({ requirements: z.array(z.string()).optional(), keywords: z.array(z.string()).optional(), notes: z.string().optional() }),
      mutates: true,
      label: () => 'Updating job details',
      run: async (args) => {
        const job = await activeJob();
        const next = await store.updateJob(job.id, args);
        changed('jobs');
        return { ok: true, requirements: next.requirements, keywords: next.keywords };
      },
    }),
    defineTool({
      name: 'set_active_job',
      description: 'Switch which saved job listing you are working on.',
      schema: z.object({ jobId: z.string() }),
      label: (a) => `Switching to ${a.jobId}`,
      run: async ({ jobId }) => {
        let job: Job;
        try {
          job = await store.getJob(jobId);
        } catch (err) {
          throw new ToolError((err as Error).message);
        }
        ctx.session.activeJobId = job.id;
        changed('jobs');
        return { ok: true, active: `${job.title} at ${job.company}` };
      },
    }),

    // ---------- CVs ----------
    defineTool({
      name: 'write_cv',
      description:
        'Hand the active job to the CV writer. It drafts (or revises base_version), saves new versions, gets them reviewed by the critic, and reports back. Takes a few minutes.',
      schema: z.object({
        instructions: z.string().describe('What to focus on: emphasis, ordering, length, issues to fix, facts to use'),
        base_version: z.coerce.number().int().optional().describe('Version to revise; omit to write from scratch'),
        user_feedback: z.string().optional().describe('The user’s own words about what to change, verbatim'),
      }),
      label: (a) => (a.base_version ? `Writer revising v${a.base_version}` : 'Writer drafting a CV'),
      run: async (args) => {
        if ((ctx.writerRuns ?? 0) >= MAX_WRITER_RUNS_PER_TURN)
          throw new ToolError('You have already run the writer this turn. Report the result to the user now and ask your questions; you can revise again next turn.');
        const job = await activeJob();
        if (args.base_version !== undefined) await getVersion(args.base_version);
        ctx.writerRuns = (ctx.writerRuns ?? 0) + 1;
        const result = await runWriter(
          {
            store,
            llm: deps.llm,
            model: deps.models.writer,
            ...(deps.think?.writer !== undefined ? { think: deps.think.writer } : {}),
            emit: ctx.emit,
            critic: criticDeps,
          },
          {
            jobId: job.id,
            instructions: args.instructions,
            ...(args.base_version !== undefined ? { baseVersion: args.base_version } : {}),
            ...(args.user_feedback ? { userFeedback: args.user_feedback } : {}),
          },
        );
        if (!result.latest) throw new ToolError(`The writer did not save a CV. Its note: ${result.notes}`);
        const { version, checks, critique } = result.latest;
        return {
          versionsSaved: result.versions,
          latestVersion: version,
          checks: { errors: checks.errorCount, warnings: checks.warningCount, words: checks.wordCount, details: formatChecks(checks) },
          review: critique ? summariseCritique(critique) : 'not reviewed yet — call critique_cv',
          writerNotes: result.notes,
        };
      },
    }),
    defineTool({
      name: 'critique_cv',
      description: 'Ask the critic to grade a CV version against the active job listing and check it against the profile.',
      schema: z.object({ version: z.coerce.number().int() }),
      label: (a) => `Critic reviewing v${a.version}`,
      run: async ({ version }) => {
        const { job } = await getVersion(version);
        const critique = await runCritic({ ...criticDeps, store, emit: ctx.emit }, { jobId: job.id, version, requestedBy: 'coordinator' });
        return { version, review: summariseCritique(critique) };
      },
    }),
    defineTool({
      name: 'show_cv_version',
      description: 'Read a CV version in full (document, checks, reviews) to discuss specific lines with the user.',
      schema: z.object({ version: z.coerce.number().int() }),
      label: (a) => `Reading v${a.version}`,
      run: async ({ version }) => {
        const { cv } = await getVersion(version);
        return {
          version: cv.version,
          status: cv.status,
          document: cv.document,
          checks: formatChecks(cv.checks),
          reviews: cv.critiques.map((c) => summariseCritique(c)),
        };
      },
    }),
    defineTool({
      name: 'update_style',
      description: `Change how the CV looks in the preview and PDF. Pass only what changes. Presets: ${Object.keys(STYLE_PRESETS).join(', ')}. Fonts: ${FONTS.map((f) => f.id).join(', ')} (or any installed font name). Sizes in pt, margins in mm.`,
      schema: z.object({ preset: z.enum(Object.keys(STYLE_PRESETS) as [string, ...string[]]).optional(), ...stylePatchShape }),
      mutates: true,
      label: () => 'Updating CV style',
      run: async (args) => {
        let style;
        try {
          style = mergeStyle(await store.getStyle(), args as Parameters<typeof mergeStyle>[1]);
        } catch (err) {
          throw new ToolError((err as Error).message);
        }
        await store.setStyle(style);
        changed('style');
        return { ok: true, style: describeStyle(style) };
      },
    }),
    defineTool({
      name: 'export_cv',
      description: 'Export a CV version to PDF/HTML/Markdown with the current style (e.g. to check page count). Does not approve it.',
      schema: z.object({ version: z.coerce.number().int() }),
      mutates: true,
      label: (a) => `Exporting v${a.version}`,
      run: async ({ version }) => {
        const { job } = await getVersion(version);
        const result = await exportCv({ store, jobId: job.id, version, style: await store.getStyle(), ...(deps.pdf ? { pdf: deps.pdf } : {}) });
        changed('cvs');
        return { ok: true, files: result.export, warnings: result.warnings };
      },
    }),
    defineTool({
      name: 'approve_cv',
      description:
        'Mark a version as final and export the submission PDF. Only when the user has confirmed. Refused while the version has check errors, has not been reviewed, or has critical review issues.',
      schema: z.object({ version: z.coerce.number().int() }),
      mutates: true,
      label: (a) => `Approving v${a.version}`,
      run: async ({ version }) => {
        const { job, cv } = await getVersion(version);
        const profile = await store.getProfile();
        const checks = checkCv(cv.document, profile, job);
        if (checks.errorCount > 0)
          throw new ToolError(`v${version} has ${checks.errorCount} check error(s) against the current profile; revise it first:\n${formatChecks(checks)}`);
        const critique = cv.critiques.at(-1);
        if (!critique) throw new ToolError(`v${version} has not been reviewed. Call critique_cv first.`);
        const critical = critique.issues.filter((i) => i.severity === 'critical');
        if (critical.length)
          throw new ToolError(`v${version} has critical review issues; revise it first:\n${critical.map((i) => `- ${i.problem}`).join('\n')}`);
        await store.updateCvVersion(job.id, version, (v) => ({ ...v, status: 'approved', approvedAt: new Date().toISOString(), checks }));
        const result = await exportCv({ store, jobId: job.id, version, style: await store.getStyle(), ...(deps.pdf ? { pdf: deps.pdf } : {}) });
        changed('cvs');
        return { ok: true, approved: `v${version}`, files: result.export, warnings: result.warnings };
      },
    }),
  ];
}

export const OPENING_NOTE =
  '[The user has just opened the app. Greet them briefly, say in one line what you will do together, then use the live state to pick the most useful next step and ask about it.]';

/**
 * One user turn: the coordinator reads the live state, talks, calls tools (including the writer and
 * critic agents), and the session is saved with what the user saw.
 */
export async function runTurn(
  deps: AppDeps,
  sessionId: string,
  input: { text: string; hidden?: boolean },
  emit: Emit,
): Promise<{ reply: string; session: Session }> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  let session = await store.getSession(sessionId);
  const at = now().toISOString();
  const userMessage: ChatMessage = { role: 'user', content: input.text };
  session = {
    ...session,
    messages: [...session.messages, userMessage],
    transcript: input.hidden ? session.transcript : [...session.transcript, { role: 'user', text: input.text, at }],
  };
  await store.saveSession(session);
  const ctx: TurnContext = { session, emit, fetched: new Map() };
  const events: string[] = [];
  const recordingEmit: Emit = (e) => {
    if (e.type === 'activity') events.push(e.text);
    emit(e);
  };
  ctx.emit = recordingEmit;

  try {
    const result = await runAgent(
      {
        name: 'coordinator',
        model: deps.models.coordinator,
        llm: deps.llm,
        system: async () => `${COORDINATOR_RULES}\n\n${await coordinatorState(deps, ctx.session, now())}`,
        tools: coordinatorTools(deps, ctx),
        maxSteps: 20,
        ...(deps.think?.coordinator !== undefined ? { think: deps.think.coordinator } : {}),
        stream: true,
        emit: recordingEmit,
        audit: store,
      },
      session.messages,
    );
    const done = now().toISOString();
    session = {
      ...ctx.session,
      messages: [...session.messages, ...result.messages],
      transcript: [
        ...session.transcript,
        ...events.map((text) => ({ role: 'event' as const, text, at: done })),
        { role: 'assistant' as const, text: result.reply, at: done },
      ],
      usage: {
        promptTokens: session.usage.promptTokens + result.usage.promptTokens,
        outputTokens: session.usage.outputTokens + result.usage.outputTokens,
        calls: session.usage.calls + result.usage.calls,
      },
    };
    session = await store.saveSession(session);
    return { reply: result.reply, session };
  } catch (err) {
    const message = (err as Error).message;
    session = {
      ...ctx.session,
      messages: session.messages,
      transcript: [...session.transcript, ...events.map((text) => ({ role: 'event' as const, text, at })), { role: 'event', text: `Error: ${message}`, at: now().toISOString() }],
    };
    await store.saveSession(session);
    await store.audit({ actor: 'coordinator', action: 'turn', outcome: 'error', details: { sessionId, error: message } });
    throw err;
  }
}
