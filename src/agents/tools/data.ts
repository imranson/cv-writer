import { z } from 'zod';
import { NotFoundError, type Json } from '../../db/repo.js';
import { countWords, extractBody, sanitizeCvHtml } from '../../lib/html.js';
import { deleteAt, getAt, mergePatch, outline, searchJson, setAt } from '../../lib/jsonpath.js';
import { defineTool, ToolError, type ToolContext } from './types.js';

const jsonObject = () => z.record(z.string(), z.any());

const jobIdField = z
  .string()
  .optional()
  .describe('Job ID. Defaults to the job currently in focus (selected in the UI / given to you).');

function resolveJobId(jobId: string | undefined, ctx: ToolContext): string {
  const id = jobId || ctx.focusJobId;
  if (!id) throw new ToolError('No jobId given and no job is in focus. Call readJob without arguments to list jobs.');
  return id;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotFoundError) throw new ToolError(`${err.message}. Call readJob without arguments to list jobs.`);
    throw err;
  }
}

/** Shared write/update semantics for JSON documents (profile, job, preferences). */
const editFields = {
  patch: jsonObject()
    .optional()
    .describe('UPDATE: JSON Merge Patch (RFC 7386) — objects merge recursively, arrays/values replace, null deletes a key.'),
  path: z
    .string()
    .optional()
    .describe('UPDATE one field: path like "experience[0].highlights[2]" or "skills[]" (append). Use with `value`.'),
  value: z.any().optional().describe('New value for `path` (any JSON).'),
  deletePath: z.string().optional().describe('UPDATE: remove the field/array item at this path.'),
};

type EditArgs = { patch?: Json; path?: string; value?: unknown; deletePath?: string };

function applyEdit(current: Json, full: Json | undefined, args: EditArgs, fullName: string): { next: Json; mode: string } {
  const modes = [full !== undefined, args.patch !== undefined, args.path !== undefined, args.deletePath !== undefined].filter(Boolean).length;
  if (modes === 0) throw new ToolError(`Provide one of: ${fullName} (write whole document), patch, path+value, deletePath`);
  if (modes > 1) throw new ToolError(`Use only one of: ${fullName}, patch, path+value, deletePath`);
  if (full !== undefined) return { next: full, mode: 'write' };
  if (args.patch !== undefined) return { next: mergePatch(current, args.patch), mode: 'patch' };
  if (args.path !== undefined) {
    if (args.value === undefined) throw new ToolError('`value` is required with `path`');
    try {
      return { next: setAt(current, args.path, args.value), mode: 'set' };
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
  }
  const [next, removed] = (() => {
    try {
      return deleteAt(current, args.deletePath!);
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
  })();
  if (!removed) throw new ToolError(`Nothing at "${args.deletePath}" to delete`);
  return { next, mode: 'delete' };
}

// ---------------- profile ----------------

export const readProfile = defineTool({
  name: 'readProfile',
  description:
    "Read the user's career profile (JSON). No arguments → the whole profile. `path` → one field (e.g. \"experience[0]\"). " +
    '`query` → keyword search across every field, returning matching paths and values.',
  schema: z.object({
    query: z.string().optional().describe('Keywords to search for (case-insensitive), e.g. "python aws".'),
    path: z.string().optional().describe('Exact path to read, e.g. "basics.email" or "education[1]".'),
  }),
  async run(args, ctx) {
    const profile = await ctx.repo.getProfile(ctx.userId);
    if (args.path) {
      const value = getAt(profile, args.path);
      return { path: args.path, found: value !== undefined, value: value ?? null };
    }
    if (args.query) {
      const hits = searchJson(profile, args.query);
      return { query: args.query, matches: hits.length, hits: hits.map(({ path, value }) => ({ path, value })) };
    }
    return profile;
  },
});

export const editProfile = defineTool({
  name: 'editProfile',
  description:
    "Write or update the user's profile (JSON). `profile` → WRITE (replace the whole document). `patch` → UPDATE by deep merge. " +
    '`path`+`value` → UPDATE a single field. `deletePath` → remove a field/item. Save facts as soon as the user shares them.',
  schema: z.object({ profile: jsonObject().optional().describe('WRITE: the complete new profile document.'), ...editFields }),
  async run(args, ctx) {
    const current = await ctx.repo.getProfile(ctx.userId);
    const { next, mode } = applyEdit(current, args.profile, args, 'profile');
    await ctx.repo.saveProfile(ctx.userId, next);
    ctx.emit({ type: 'data_changed', entity: 'profile' });
    return { ok: true, mode, outline: outline(next) };
  },
});

// ---------------- jobs ----------------

export const readJob = defineTool({
  name: 'readJob',
  description:
    'Read target jobs. No jobId and no focus → list all jobs (id, title, company, status, hasCv). With jobId → the full job JSON. ' +
    '`path` → one field of that job. Set `list: true` to list jobs even when one is in focus.',
  schema: z.object({
    jobId: jobIdField,
    path: z.string().optional().describe('Read only this field of the job.'),
    list: z.boolean().optional().describe('List all jobs.'),
  }),
  async run(args, ctx) {
    const id = args.list ? undefined : args.jobId || ctx.focusJobId;
    if (!id) {
      const jobs = await ctx.repo.listJobs(ctx.userId);
      return { count: jobs.length, jobs: jobs.map(({ id, title, company, status, hasCv }) => ({ id, title, company, status, hasCv })) };
    }
    const job = await guard(() => ctx.repo.getJob(ctx.userId, id));
    if (args.path) return { jobId: id, path: args.path, value: getAt(job.data, args.path) ?? null };
    return { jobId: job.id, ...job.data };
  },
});

export const editJob = defineTool({
  name: 'editJob',
  description:
    'Create or update a target job (JSON: title, company, location, url, description, requirements[], keywords[], notes, status). ' +
    'Without jobId → CREATE a new job from `job` (also creates its empty CV, preferences and stylesheet) and return its id. ' +
    'With jobId → `job` replaces the document, `patch` deep-merges, `path`+`value` sets a field, `deletePath` removes one.',
  schema: z.object({
    jobId: z.string().optional().describe('Job to update. Omit to create a new job.'),
    job: jsonObject().optional().describe('CREATE / WRITE: the job document.'),
    ...editFields,
  }),
  async run(args, ctx) {
    if (!args.jobId) {
      const data = args.job ?? args.patch ?? {};
      const job = await ctx.repo.createJob(ctx.userId, data);
      ctx.emit({ type: 'data_changed', entity: 'jobs', jobId: job.id });
      return { ok: true, mode: 'create', jobId: job.id, job: job.data };
    }
    const jobId = args.jobId;
    return guard(async () => {
      const current = await ctx.repo.getJob(ctx.userId, jobId);
      const { next, mode } = applyEdit(current.data, args.job, args, 'job');
      await ctx.repo.saveJob(ctx.userId, jobId, next);
      ctx.emit({ type: 'data_changed', entity: 'job', jobId });
      return { ok: true, mode, jobId, outline: outline(next) };
    });
  },
});

// ---------------- CV (HTML) & CSS ----------------

export const readCV = defineTool({
  name: 'readCV',
  description:
    "Read a job's CV: the HTML fragment, word count and rendered PDF page count. The CV is empty until the writer creates it.",
  schema: z.object({ jobId: jobIdField }),
  async run(args, ctx) {
    const jobId = resolveJobId(args.jobId, ctx);
    const cv = await guard(() => ctx.repo.getCv(ctx.userId, jobId));
    const empty = cv.html.trim() === '';
    const pages = !empty && ctx.pageCount ? await ctx.pageCount(jobId).catch(() => null) : null;
    return { jobId, empty, words: countWords(cv.html), pages, updatedAt: cv.updatedAt, html: cv.html };
  },
});

const editsField = z
  .array(z.object({ find: z.string().min(1), replace: z.string(), all: z.boolean().optional() }))
  .optional()
  .describe('UPDATE: exact find/replace edits applied in order. `find` must occur exactly once unless `all` is true.');

function applyTextEdits(source: string, edits: { find: string; replace: string; all?: boolean }[]): string {
  let out = source;
  edits.forEach((e, i) => {
    const count = out.split(e.find).length - 1;
    if (count === 0) throw new ToolError(`Edit ${i + 1}: text not found: ${JSON.stringify(e.find.slice(0, 120))}`);
    if (count > 1 && !e.all) {
      throw new ToolError(`Edit ${i + 1}: text occurs ${count} times — add surrounding context or set all: true`);
    }
    out = e.all ? out.split(e.find).join(e.replace) : out.replace(e.find, () => e.replace);
  });
  return out;
}

export const editCV = defineTool({
  name: 'editCV',
  description:
    "Write or update a job's CV HTML. `html` → WRITE the whole CV (an HTML fragment: body content only, no <html>/<head>/<script>). " +
    '`edits` → UPDATE with exact find/replace edits.',
  schema: z.object({ jobId: jobIdField, html: z.string().optional().describe('WRITE: complete CV HTML fragment.'), edits: editsField }),
  async run(args, ctx) {
    const jobId = resolveJobId(args.jobId, ctx);
    if ((args.html === undefined) === (args.edits === undefined)) throw new ToolError('Provide exactly one of `html` or `edits`');
    return guard(async () => {
      const current = (await ctx.repo.getCv(ctx.userId, jobId)).html;
      const next = sanitizeCvHtml(extractBody(args.html ?? applyTextEdits(current, args.edits!)));
      const saved = await ctx.repo.saveCvHtml(ctx.userId, jobId, next);
      ctx.emit({ type: 'data_changed', entity: 'cv', jobId });
      return { ok: true, mode: args.html !== undefined ? 'write' : 'edit', jobId, words: countWords(saved.html), chars: saved.html.length };
    });
  },
});

export const readCSS = defineTool({
  name: 'readCSS',
  description: "Read the raw CSS stylesheet applied to a job's CV (used for preview and PDF).",
  schema: z.object({ jobId: jobIdField }),
  async run(args, ctx) {
    const jobId = resolveJobId(args.jobId, ctx);
    return { jobId, css: await guard(() => ctx.repo.getCss(ctx.userId, jobId)) };
  },
});

export const editCSS = defineTool({
  name: 'editCSS',
  description:
    "Write or update a CV's CSS stylesheet (shown raw to the user). `css` → WRITE the whole stylesheet; `edits` → exact find/replace. " +
    'Use @page for margins; PDF page size comes from preferences.pageSize.',
  schema: z.object({ jobId: jobIdField, css: z.string().optional().describe('WRITE: complete stylesheet.'), edits: editsField }),
  async run(args, ctx) {
    const jobId = resolveJobId(args.jobId, ctx);
    if ((args.css === undefined) === (args.edits === undefined)) throw new ToolError('Provide exactly one of `css` or `edits`');
    return guard(async () => {
      const current = await ctx.repo.getCss(ctx.userId, jobId);
      const next = args.css ?? applyTextEdits(current, args.edits!);
      await ctx.repo.saveCss(ctx.userId, jobId, next);
      ctx.emit({ type: 'data_changed', entity: 'css', jobId });
      return { ok: true, mode: args.css !== undefined ? 'write' : 'edit', jobId, chars: next.length };
    });
  },
});

// ---------------- preferences ----------------

export const readPreferences = defineTool({
  name: 'readPreferences',
  description:
    "Read the per-CV preferences (JSON) for a job: pageSize (A4|Letter), maxPages, tone, language, sections order, emphasis, avoid, notes.",
  schema: z.object({ jobId: jobIdField }),
  async run(args, ctx) {
    const jobId = resolveJobId(args.jobId, ctx);
    return { jobId, ...(await guard(() => ctx.repo.getPreferences(ctx.userId, jobId))) };
  },
});

export const editPreferences = defineTool({
  name: 'editPreferences',
  description:
    "Write or update a CV's preferences (JSON). `preferences` → WRITE the whole document; `patch` → deep merge; " +
    '`path`+`value` → set one field; `deletePath` → remove one.',
  schema: z.object({
    jobId: jobIdField,
    preferences: jsonObject().optional().describe('WRITE: the complete preferences document.'),
    ...editFields,
  }),
  async run(args, ctx) {
    const jobId = resolveJobId(args.jobId, ctx);
    return guard(async () => {
      const current = await ctx.repo.getPreferences(ctx.userId, jobId);
      const { next, mode } = applyEdit(current, args.preferences, args, 'preferences');
      if (next.pageSize !== undefined && !['A4', 'Letter'].includes(String(next.pageSize))) {
        throw new ToolError('pageSize must be "A4" or "Letter"');
      }
      const saved = await ctx.repo.savePreferences(ctx.userId, jobId, next);
      ctx.emit({ type: 'data_changed', entity: 'preferences', jobId });
      return { ok: true, mode, jobId, preferences: saved };
    });
  },
});
