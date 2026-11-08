import { z } from 'zod';
import { applyOps, applyTextEdits, getAt, searchJson, type JsonOp } from '../../lib/jsonOps.js';
import { htmlToText, sanitizeCvHtml } from '../../lib/html.js';
import { now, type DataEntity } from '../events.js';
import { defineTool, ToolError, type ToolContext } from '../tool.js';
import type { CvBundle, JsonObject } from '../../db/repo.js';

// ---------- shared schemas & helpers ----------

const jsonObject = z.record(z.string(), z.any());

const operationSchema = z.object({
  op: z.enum(['set', 'merge', 'append', 'remove']).describe('set = replace value at path; merge = deep-merge an object; append = push onto an array; remove = delete key/array item'),
  path: z.string().describe('Dot/bracket path such as "experience[0].highlights" or "contact.email". Use "" for the document root (set/merge only).'),
  value: z.any().optional().describe('JSON value for set/merge/append'),
});

const operations = z.array(operationSchema).min(1);

const textEdit = z.object({
  find: z.string().min(1).describe('Exact existing text to replace (must be unique unless all=true)'),
  replace: z.string().describe('Replacement text'),
  all: z.boolean().optional().describe('Replace every occurrence'),
});

const jobIdArg = z.string().optional().describe('Job id (from readJob). Subagents default to the job they were assigned.');

function resolveJobId(jobId: string | undefined, ctx: ToolContext): string {
  const id = jobId ?? ctx.boundJobId;
  if (!id) throw new ToolError('jobId is required. Call readJob without arguments to list job ids.');
  return id;
}

async function loadCv(ctx: ToolContext, jobId: string | undefined): Promise<CvBundle> {
  const id = resolveJobId(jobId, ctx);
  const cv = await ctx.services.repo.getCv(ctx.userId, id);
  if (!cv) throw new ToolError(`No job/CV found with id "${id}". Call readJob without arguments to list job ids.`);
  return cv;
}

function changed(ctx: ToolContext, entity: DataEntity, jobId?: string) {
  ctx.emit({ type: 'data_changed', entity, jobId, at: now() });
}

function applyOperations<T extends object>(doc: T, ops: JsonOp[]): T {
  try {
    return applyOps(doc, ops);
  } catch (err) {
    throw new ToolError(`Could not apply operations: ${(err as Error).message}`);
  }
}

async function pageCount(ctx: ToolContext, cv: Pick<CvBundle, 'html' | 'css' | 'preferences'>): Promise<number | undefined> {
  if (!ctx.services.pages || !cv.html.trim()) return undefined;
  try {
    return await ctx.services.pages.countPages(cv.html, cv.css, cv.preferences);
  } catch {
    return undefined;
  }
}

const wordCount = (html: string) => htmlToText(html).text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// ---------- profile ----------

export const readProfile = defineTool({
  name: 'readProfile',
  description:
    "Read the user's career profile (JSON). No arguments: returns the whole profile. `path`: returns the value at that path. `query`: searches all values and returns matching paths (use to find facts in a large profile).",
  schema: z.object({
    path: z.string().optional().describe('Dot/bracket path to read, e.g. "experience[1]"'),
    query: z.string().optional().describe('Search terms, e.g. "python aws"'),
  }),
  async run({ path, query }, ctx) {
    const profile = await ctx.services.repo.getProfile(ctx.userId);
    if (query) {
      const matches = searchJson(profile, query);
      return { mode: 'search', query, count: matches.length, matches };
    }
    if (path) {
      try {
        return { mode: 'read', path, value: getAt(profile, path) ?? null };
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    }
    return Object.keys(profile).length === 0
      ? { mode: 'read', profile, note: 'The profile is empty. Interview the user to fill it.' }
      : { mode: 'read', profile };
  },
});

export const editProfile = defineTool({
  name: 'editProfile',
  description:
    "Write or update the user's career profile (JSON). Pass `profile` to WRITE (replace the whole document) or `operations` to UPDATE specific paths. Prefer `operations` for incremental changes. Only store facts the user stated.",
  schema: z.object({
    profile: jsonObject.optional().describe('Complete new profile document (replaces everything)'),
    operations: operations.optional().describe('Targeted updates applied in order'),
  }),
  async run({ profile, operations: ops }, ctx) {
    if (!profile && !ops) throw new ToolError('Provide `profile` (write) or `operations` (update).');
    const { repo } = ctx.services;
    let doc: JsonObject = profile ?? (await repo.getProfile(ctx.userId));
    if (ops) doc = applyOperations(doc, ops as JsonOp[]);
    await repo.saveProfile(ctx.userId, doc);
    changed(ctx, 'profile');
    return {
      ok: true,
      mode: profile ? 'write' : 'update',
      updatedPaths: ops?.map((o) => `${o.op} ${o.path || '(root)'}`) ?? ['(entire profile)'],
      topLevelKeys: Object.keys(doc),
    };
  },
});

// ---------- jobs ----------

export const readJob = defineTool({
  name: 'readJob',
  description:
    'Read target jobs. No `jobId`: lists all jobs (id, title, company, CV size). With `jobId`: returns the job JSON. `query` searches job descriptions (within one job if jobId is given).',
  schema: z.object({
    jobId: z.string().optional().describe('Job id to read'),
    query: z.string().optional().describe('Search terms'),
  }),
  async run({ jobId, query }, ctx) {
    const { repo } = ctx.services;
    const id = jobId ?? (ctx.agent === 'coordinator' ? undefined : ctx.boundJobId);
    if (!id) {
      const jobs = await repo.listJobs(ctx.userId);
      if (!query) return { mode: 'list', count: jobs.length, jobs };
      const matches = [];
      for (const j of jobs) {
        const job = await repo.getJob(ctx.userId, j.id);
        for (const m of searchJson(job?.data ?? {}, query, 10)) matches.push({ jobId: j.id, ...m });
      }
      return { mode: 'search', query, count: matches.length, matches };
    }
    const job = await repo.getJob(ctx.userId, id);
    if (!job) throw new ToolError(`No job found with id "${id}". Call readJob without arguments to list jobs.`);
    if (query) return { mode: 'search', jobId: id, query, matches: searchJson(job.data, query) };
    const cv = await repo.getCv(ctx.userId, id);
    return { mode: 'read', jobId: id, job: job.data, cv: { chars: cv?.html.length ?? 0, empty: !cv?.html.trim() } };
  },
});

export const editJob = defineTool({
  name: 'editJob',
  description:
    'Create, write or update a target job (JSON). No `jobId` + `job`: CREATE a new job (a CV, CV preferences and stylesheet are created with it). `jobId` + `job`: WRITE (replace). `jobId` + `operations`: UPDATE paths. Include at least title and company; keep the full advert text in `description`.',
  schema: z.object({
    jobId: z.string().optional().describe('Existing job id; omit to create a new job'),
    job: jsonObject.optional().describe('Job document, e.g. {title, company, location, url, description, requirements[], niceToHave[], notes}'),
    operations: operations.optional(),
  }),
  async run({ jobId, job, operations: ops }, ctx) {
    const { repo } = ctx.services;
    if (!jobId) {
      if (!job) throw new ToolError('To create a job pass `job`. To update one pass `jobId`.');
      const doc = ops ? applyOperations(job, ops as JsonOp[]) : job;
      const created = await repo.createJob(ctx.userId, doc);
      changed(ctx, 'job', created.id);
      return { ok: true, mode: 'create', jobId: created.id, title: doc.title ?? null, company: doc.company ?? null };
    }
    const existing = await repo.getJob(ctx.userId, jobId);
    if (!existing) throw new ToolError(`No job found with id "${jobId}".`);
    if (!job && !ops) throw new ToolError('Provide `job` (write) or `operations` (update).');
    let doc: JsonObject = job ?? existing.data;
    if (ops) doc = applyOperations(doc, ops as JsonOp[]);
    await repo.saveJob(ctx.userId, jobId, doc);
    changed(ctx, 'job', jobId);
    return { ok: true, mode: job ? 'write' : 'update', jobId, title: doc.title ?? null, company: doc.company ?? null };
  },
});

// ---------- CV (HTML) ----------

export const readCV = defineTool({
  name: 'readCV',
  description:
    'Read the CV (HTML body fragment) for a job, with word count and rendered page count. Styling lives separately in the CSS (readCSS).',
  schema: z.object({ jobId: jobIdArg }),
  async run({ jobId }, ctx) {
    const cv = await loadCv(ctx, jobId);
    if (!cv.html.trim()) return { jobId: cv.jobId, empty: true, html: '', note: 'No CV has been written for this job yet.' };
    return {
      jobId: cv.jobId,
      empty: false,
      words: wordCount(cv.html),
      pages: await pageCount(ctx, cv),
      updatedAt: cv.updatedAt,
      html: cv.html,
    };
  },
});

export const editCV = defineTool({
  name: 'editCV',
  description:
    'Write or update the CV HTML for a job. Pass `html` to WRITE the full CV (semantic HTML body content only: no <html>, <head>, <style> or <script>). Pass `edits` (exact find/replace pairs) to UPDATE parts. Returns word and rendered page counts.',
  schema: z.object({
    jobId: jobIdArg,
    html: z.string().optional().describe('Complete CV HTML body fragment'),
    edits: z.array(textEdit).min(1).optional().describe('Find/replace edits applied in order to the current HTML'),
  }),
  async run({ jobId, html, edits }, ctx) {
    if (html === undefined && !edits) throw new ToolError('Provide `html` (write) or `edits` (update).');
    const cv = await loadCv(ctx, jobId);
    let next = html ?? cv.html;
    if (edits) {
      try {
        next = applyTextEdits(next, edits);
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    }
    next = sanitizeCvHtml(next);
    await ctx.services.repo.saveCvHtml(ctx.userId, cv.jobId, next);
    changed(ctx, 'cv', cv.jobId);
    return {
      ok: true,
      mode: html !== undefined ? 'write' : 'update',
      jobId: cv.jobId,
      chars: next.length,
      words: wordCount(next),
      pages: await pageCount(ctx, { ...cv, html: next }),
      maxPages: cv.preferences.maxPages ?? null,
    };
  },
});

// ---------- CSS ----------

export const readCSS = defineTool({
  name: 'readCSS',
  description: 'Read the raw CSS stylesheet applied to the CV for a job (screen preview and PDF).',
  schema: z.object({ jobId: jobIdArg }),
  async run({ jobId }, ctx) {
    const cv = await loadCv(ctx, jobId);
    return { jobId: cv.jobId, css: cv.css };
  },
});

export const editCSS = defineTool({
  name: 'editCSS',
  description:
    'Write or update the CV stylesheet for a job. Pass `css` to WRITE the whole stylesheet or `edits` (exact find/replace pairs) to UPDATE parts. Use @page for paper size and margins. External resources other than Google Fonts are blocked in the PDF.',
  schema: z.object({
    jobId: jobIdArg,
    css: z.string().optional().describe('Complete stylesheet'),
    edits: z.array(textEdit).min(1).optional(),
  }),
  async run({ jobId, css, edits }, ctx) {
    if (css === undefined && !edits) throw new ToolError('Provide `css` (write) or `edits` (update).');
    const cv = await loadCv(ctx, jobId);
    let next = css ?? cv.css;
    if (edits) {
      try {
        next = applyTextEdits(next, edits);
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    }
    if (/<\/?style|<script/i.test(next)) throw new ToolError('CSS must not contain HTML tags.');
    await ctx.services.repo.saveCss(ctx.userId, cv.jobId, next);
    changed(ctx, 'css', cv.jobId);
    return { ok: true, mode: css !== undefined ? 'write' : 'update', jobId: cv.jobId, chars: next.length, pages: await pageCount(ctx, { ...cv, css: next }) };
  },
});

// ---------- per-CV preferences ----------

export const readPreferences = defineTool({
  name: 'readPreferences',
  description:
    'Read the preferences (JSON) for the CV of a job: language, paperSize, maxPages, tone, sectionOrder, emphasise, exclude, notes, etc.',
  schema: z.object({ jobId: jobIdArg }),
  async run({ jobId }, ctx) {
    const cv = await loadCv(ctx, jobId);
    return { jobId: cv.jobId, preferences: cv.preferences };
  },
});

export const editPreferences = defineTool({
  name: 'editPreferences',
  description:
    'Write or update the preferences for the CV of a job. Pass `preferences` to WRITE (replace) or `operations` to UPDATE paths (e.g. set maxPages, append to emphasise).',
  schema: z.object({
    jobId: z.string().describe('Job id whose CV preferences to change'),
    preferences: jsonObject.optional(),
    operations: operations.optional(),
  }),
  async run({ jobId, preferences, operations: ops }, ctx) {
    if (!preferences && !ops) throw new ToolError('Provide `preferences` (write) or `operations` (update).');
    const cv = await loadCv(ctx, jobId);
    let doc: JsonObject = preferences ?? cv.preferences;
    if (ops) doc = applyOperations(doc, ops as JsonOp[]);
    await ctx.services.repo.savePreferences(ctx.userId, cv.jobId, doc);
    changed(ctx, 'preferences', cv.jobId);
    return { ok: true, mode: preferences ? 'write' : 'update', jobId: cv.jobId, preferences: doc };
  },
});
