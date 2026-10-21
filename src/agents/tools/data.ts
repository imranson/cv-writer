import { z } from 'zod';
import { appendPath, deepMerge, getPath, parsePath, formatPath, removePath, searchJson, setPath } from '../../util/jsonPath';
import { applyTextEdits, sanitizeHtml } from '../../util/text';
import type { CvPreferences, Job } from '../../store';
import { defineTool } from '../types';

const jsonObject = z.record(z.string(), z.unknown());
const textEdits = z
  .array(
    z.object({
      find: z.string().describe('Exact existing text to find'),
      replace: z.string().describe('Replacement text'),
      all: z.boolean().optional().describe('Replace every occurrence'),
    }),
  )
  .describe('Exact find/replace edits applied in order');

// ---- profile ---------------------------------------------------------------

export const readProfile = defineTool({
  name: 'readProfile',
  description:
    "Read the user's career profile. No arguments: returns the whole profile. `path` (e.g. \"experience[0]\" or \"skills\"): " +
    'returns just that part. `query` (e.g. "python aws"): searches all fields and returns matching values with their paths ' +
    'and the entries they belong to.',
  schema: z.object({
    path: z.string().optional().describe('Dotted path to read, e.g. "contact.email" or "experience[1].highlights"'),
    query: z.string().optional().describe('Search terms; every term must match a field path or value'),
  }),
  async run({ path, query }, ctx) {
    const profile = await ctx.deps.store.getProfile(ctx.userId);
    if (query) {
      const matches = searchJson(path ? getPath(profile, path) : profile, query);
      const prefix = path ? parsePath(path) : [];
      const entries: Record<string, unknown> = {};
      for (const hit of matches) {
        // Group each hit with its containing entry, e.g. experience[2], so the model sees context.
        const keys = [...prefix, ...parsePath(hit.path)];
        const entryKeys = keys.slice(0, Math.min(2, keys.length - 1) || 1);
        const entryPath = formatPath(entryKeys);
        if (!(entryPath in entries)) entries[entryPath] = getPath(profile, entryPath);
      }
      return { mode: 'search', query, matchCount: matches.length, matches, entries };
    }
    if (path) return { mode: 'read', path, value: getPath(profile, path) ?? null };
    return { mode: 'read', profile };
  },
});

export const editProfile = defineTool({
  name: 'editProfile',
  description:
    "Write or update the user's career profile. Pass `profile` to write (replace) the whole profile. " +
    'Otherwise update one location: `path` + `value` with `op` = "set" (default), "merge" (deep-merge an object), ' +
    '"append" (push onto an array) or "remove" (delete the key/array item). Only record facts the user actually gave you.',
  schema: z.object({
    profile: jsonObject.optional().describe('Complete replacement profile object (write mode)'),
    path: z.string().optional().describe('Dotted path to update, e.g. "experience" or "contact.phone". Empty = root (merge only)'),
    op: z.enum(['set', 'merge', 'append', 'remove']).optional().describe('Update operation (default "set")'),
    value: z.unknown().optional().describe('Value for set/merge/append'),
  }),
  async run({ profile, path, op, value }, ctx) {
    const store = ctx.deps.store;
    if (profile) {
      await store.saveProfile(ctx.userId, profile);
      ctx.emit({ type: 'data_changed', kind: 'profile' });
      return { mode: 'write', ok: true, topLevelKeys: Object.keys(profile) };
    }
    const operation = op ?? 'set';
    if (path === undefined && operation !== 'merge') throw new Error('Provide `profile` to write, or `path` to update');
    if (operation !== 'remove' && value === undefined) throw new Error(`op "${operation}" needs a value`);
    const current = await store.getProfile(ctx.userId);
    const p = path ?? '';
    let next: Record<string, unknown>;
    switch (operation) {
      case 'set':
        next = setPath(current, p, value);
        break;
      case 'merge':
        next = setPath(current, p, deepMerge(getPath(current, p) ?? {}, value));
        break;
      case 'append':
        next = appendPath(current, p, value);
        break;
      case 'remove':
        next = removePath(current, p);
        break;
    }
    if (next === null || typeof next !== 'object' || Array.isArray(next)) throw new Error('Profile root must stay an object');
    await store.saveProfile(ctx.userId, next);
    ctx.emit({ type: 'data_changed', kind: 'profile' });
    return { mode: 'update', op: operation, path: p, value: operation === 'remove' ? null : getPath(next, p) };
  },
});

// ---- jobs ------------------------------------------------------------------

export const readJob = defineTool({
  name: 'readJob',
  description: 'Read target jobs. No arguments: lists all jobs (id, title, company, status). With `jobId`: returns the full job, including the posting text.',
  schema: z.object({ jobId: z.string().optional().describe('Job id to read in full') }),
  async run({ jobId }, ctx) {
    if (!jobId) return { jobs: await ctx.deps.store.listJobs(ctx.userId) };
    return { job: await ctx.deps.store.requireJob(ctx.userId, jobId) };
  },
});

export const editJob = defineTool({
  name: 'editJob',
  description:
    'Create, update or delete a target job. Without `jobId`: creates a job from `job` (title, company, location, url, ' +
    'description = full posting text, notes, status) and its empty CV. With `jobId` + `job`: updates those fields. ' +
    'With `jobId` + `delete: true`: deletes the job and its CV, preferences and CSS (confirm with the user first).',
  schema: z.object({
    jobId: z.string().optional(),
    job: jsonObject.optional().describe('Job fields to create or update'),
    delete: z.boolean().optional(),
  }),
  async run({ jobId, job, delete: del }, ctx) {
    const store = ctx.deps.store;
    if (!jobId) {
      if (!job) throw new Error('Provide `job` fields to create a job');
      const created = await store.createJob(ctx.userId, job as Partial<Job>);
      ctx.emit({ type: 'data_changed', kind: 'job', jobId: created.id });
      return { mode: 'create', job: created };
    }
    if (del) {
      const deleted = await store.deleteJob(ctx.userId, jobId);
      ctx.emit({ type: 'data_changed', kind: 'job', jobId });
      return { mode: 'delete', jobId, deleted };
    }
    if (!job) throw new Error('Provide `job` fields to update, or delete: true');
    const updated = await store.updateJob(ctx.userId, jobId, job as Partial<Job>);
    ctx.emit({ type: 'data_changed', kind: 'job', jobId });
    return { mode: 'update', job: updated };
  },
});

// ---- CV ------------------------------------------------------------------

export const readCV = defineTool({
  name: 'readCV',
  description: "Read the CV for a job: its HTML body. Use readPreferences for the CV's preferences.",
  schema: z.object({ jobId: z.string().describe('Job id the CV belongs to') }),
  async run({ jobId }, ctx) {
    return { jobId, html: await ctx.deps.store.getCv(ctx.userId, jobId) };
  },
});

export const editCV = defineTool({
  name: 'editCV',
  description:
    "Write or edit a job's CV. `html` replaces the whole CV body (semantic HTML fragment, no <html>/<head>/<style>/<script>). " +
    '`edits` applies exact find/replace edits — prefer this for small changes.',
  schema: z.object({
    jobId: z.string(),
    html: z.string().optional().describe('Complete CV body HTML'),
    edits: textEdits.optional(),
  }),
  async run({ jobId, html, edits }, ctx) {
    const store = ctx.deps.store;
    if (html === undefined && !edits?.length) throw new Error('Provide html or edits');
    let next = html ?? (await store.getCv(ctx.userId, jobId));
    if (edits?.length) next = applyTextEdits(next, edits);
    next = sanitizeHtml(next);
    await store.saveCv(ctx.userId, jobId, next);
    ctx.emit({ type: 'data_changed', kind: 'cv', jobId });
    return { jobId, htmlLength: next.length, editsApplied: edits?.length ?? 0 };
  },
});

// ---- CV preferences (1 per CV) --------------------------------------------

const preferenceFields = z
  .object({
    pageSize: z.enum(['A4', 'Letter']).optional(),
    maxPages: z.coerce.number().int().min(1).optional().describe('Page limit, not a target'),
    tone: z.string().optional().describe('e.g. "professional", "warm", "concise"'),
    language: z.string().optional().describe('Spelling variant, e.g. "en-GB" or "en-US"'),
    sectionOrder: z.array(z.string()).optional().describe('Section ids in order, e.g. ["header", "summary", "experience"]'),
    emphasis: z.array(z.string()).optional().describe('Skills, roles or themes to lead with'),
    exclude: z.array(z.string()).optional().describe('Sections or items to leave out'),
    notes: z.string().optional().describe('Any other instructions for this CV'),
  })
  .catchall(z.unknown());

export const readPreferences = defineTool({
  name: 'readPreferences',
  description: "Read a CV's preferences: page size, max pages, tone, language, section order, emphasis, exclusions and notes.",
  schema: z.object({ jobId: z.string().describe('Job id the CV belongs to') }),
  async run({ jobId }, ctx) {
    return { jobId, preferences: await ctx.deps.store.getPreferences(ctx.userId, jobId) };
  },
});

export const editPreferences = defineTool({
  name: 'editPreferences',
  description:
    "Update a CV's preferences. `preferences` holds only the fields to change; each replaces its stored value " +
    '(arrays are replaced whole, so send the full list) and other fields are kept. Only record what the user asked for.',
  schema: z.object({
    jobId: z.string().describe('Job id the CV belongs to'),
    preferences: preferenceFields.describe('Preference fields to change'),
  }),
  async run({ jobId, preferences }, ctx) {
    if (Object.keys(preferences).length === 0) throw new Error('Provide at least one preference field to change');
    const store = ctx.deps.store;
    const merged = { ...(await store.getPreferences(ctx.userId, jobId)), ...preferences } as CvPreferences;
    const saved = await store.savePreferences(ctx.userId, jobId, merged);
    ctx.emit({ type: 'data_changed', kind: 'preferences', jobId });
    return { jobId, preferences: saved };
  },
});

// ---- CSS -------------------------------------------------------------------

export const readCSS = defineTool({
  name: 'readCSS',
  description: "Read the raw CSS stylesheet used to render a job's CV (screen preview and PDF).",
  schema: z.object({ jobId: z.string() }),
  async run({ jobId }, ctx) {
    return { jobId, css: await ctx.deps.store.getCss(ctx.userId, jobId) };
  },
});

export const editCSS = defineTool({
  name: 'editCSS',
  description:
    "Write or edit a job's CV stylesheet. `css` replaces it entirely; `edits` applies exact find/replace edits. " +
    'Use @page for paper size and margins; the PDF is printed from this CSS.',
  schema: z.object({ jobId: z.string(), css: z.string().optional(), edits: textEdits.optional() }),
  async run({ jobId, css, edits }, ctx) {
    if (css === undefined && !edits?.length) throw new Error('Provide css or edits');
    let next = css ?? (await ctx.deps.store.getCss(ctx.userId, jobId));
    if (edits?.length) next = applyTextEdits(next, edits);
    if (/<\/?style|<script/i.test(next)) throw new Error('CSS must not contain HTML tags');
    await ctx.deps.store.saveCss(ctx.userId, jobId, next);
    ctx.emit({ type: 'data_changed', kind: 'css', jobId });
    return { jobId, cssLength: next.length, editsApplied: edits?.length ?? 0 };
  },
});
