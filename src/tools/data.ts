import { z } from 'zod';
import type { JsonOp } from '../lib/jsonOps.js';
import type { Workspace } from '../storage/workspace.js';
import { defineTool, jsonish, type Tool } from './tool.js';

const id = (what: string) => z.string().min(1).describe(`${what} id`);
const object = (description: string) => jsonish(z.record(z.string(), z.unknown())).describe(description);

const jsonOpSchema = z.object({
  op: z.enum(['set', 'delete', 'append', 'merge']).describe(
    'set: write value at path; delete: remove path; append: push value onto array at path; merge: shallow-merge object value into object at path ("" = root)',
  ),
  path: z.string().describe('Dot/bracket path, e.g. "experience.0.highlights" or "contact.email"'),
  value: z.unknown().optional().describe('Value for set/append/merge'),
});
const jsonOps = (description: string) => jsonish(z.array(jsonOpSchema).min(1)).describe(description);

function toJsonOps(ops: z.infer<typeof jsonOpSchema>[]): JsonOp[] {
  return ops.map((o) => {
    if (o.op !== 'delete' && o.value === undefined) throw new Error(`"${o.op}" at "${o.path}" needs a value`);
    return o as JsonOp;
  });
}

const textEdit = z.object({
  find: z.string().describe('Exact text to find (must be unique unless all=true)'),
  replace: z.string().describe('Replacement text'),
  all: z.boolean().optional().describe('Replace every occurrence'),
});

const limit = z.number().int().min(1).max(50).optional().describe('Max results (default 10)');

export function profileTools(ws: Workspace) {
  return {
    readProfile: defineTool({
      name: 'readProfile',
      description: 'Read a user profile (JSON) by id. Omit profileId to list all profiles with their ids and names.',
      schema: z.object({ profileId: id('Profile').optional() }),
      run: async ({ profileId }) => {
        if (!profileId) return { profiles: await ws.listProfiles() };
        const profile = await ws.getProfile(profileId);
        if (!profile) throw new Error(`Profile "${profileId}" not found. Call readProfile without an id to list profiles.`);
        return profile;
      },
    }),
    writeProfile: defineTool({
      name: 'writeProfile',
      description:
        'Create a profile (omit profileId) or fully replace an existing one. The profile is free-form JSON; suggested keys: ' +
        'name, headline, contact {email, phone, location, links[]}, summary, experience [{title, company, location, start, end, ' +
        'highlights[]}], education [], skills [], certifications [], languages [], projects [], interests [], notes. ' +
        'Returns the saved profile including its id. Prefer editProfile for incremental updates.',
      schema: z.object({ profileId: id('Profile').optional(), profile: object('The complete profile JSON') }),
      run: async ({ profileId, profile }, ctx) => {
        const saved = await ws.saveProfile(profileId, profile);
        ctx.emit({ type: 'data_changed', kind: 'profile', id: String(saved.id) });
        return saved;
      },
    }),
    editProfile: defineTool({
      name: 'editProfile',
      description:
        'Apply path-based edits to an existing profile, e.g. [{"op":"append","path":"experience","value":{...}}, ' +
        '{"op":"set","path":"contact.email","value":"a@b.com"}, {"op":"delete","path":"skills.3"}]. All-or-nothing.',
      schema: z.object({ profileId: id('Profile'), operations: jsonOps('Edit operations, applied in order') }),
      run: async ({ profileId, operations }, ctx) => {
        const saved = await ws.editProfile(profileId, toJsonOps(operations));
        ctx.emit({ type: 'data_changed', kind: 'profile', id: profileId });
        return saved;
      },
    }),
  };
}

export function jobTools(ws: Workspace) {
  return {
    readJob: defineTool({
      name: 'readJob',
      description: 'Read a job (JSON) by id. Omit jobId to list jobs (optionally only those linked to profileId), including whether each has a CV.',
      schema: z.object({ jobId: id('Job').optional(), profileId: id('Profile').optional() }),
      run: async ({ jobId, profileId }) => {
        if (!jobId) return { jobs: await ws.listJobs(profileId) };
        const job = await ws.getJob(jobId);
        if (!job) throw new Error(`Job "${jobId}" not found. Call readJob without an id to list jobs.`);
        return job;
      },
    }),
    writeJob: defineTool({
      name: 'writeJob',
      description:
        'Create a job (omit jobId) or fully replace one. Link it to the user with profileId (a profile has many jobs; each job ' +
        'has one CV). Free-form JSON; suggested keys: title, company, location, url, description, responsibilities [], ' +
        'requirements [], niceToHave [], keywords [], salary, deadline, status, notes. Keep the original posting text in description.',
      schema: z.object({
        jobId: id('Job').optional(),
        profileId: id('Profile').optional().describe('Owner profile id'),
        job: object('The complete job JSON'),
      }),
      run: async ({ jobId, profileId, job }, ctx) => {
        const saved = await ws.saveJob(jobId, profileId, job);
        ctx.emit({ type: 'data_changed', kind: 'job', id: String(saved.id) });
        return saved;
      },
    }),
    editJob: defineTool({
      name: 'editJob',
      description: 'Apply path-based edits to an existing job, same operation format as editProfile. All-or-nothing.',
      schema: z.object({ jobId: id('Job'), operations: jsonOps('Edit operations, applied in order') }),
      run: async ({ jobId, operations }, ctx) => {
        const saved = await ws.editJob(jobId, toJsonOps(operations));
        ctx.emit({ type: 'data_changed', kind: 'job', id: jobId });
        return saved;
      },
    }),
    searchJobs: defineTool({
      name: 'searchJobs',
      description: 'Keyword search across saved jobs. Returns ids, titles, scores and matching snippets.',
      schema: z.object({ query: z.string().min(1), profileId: id('Profile').optional(), limit }),
      run: async ({ query, profileId, limit }) => ({ results: await ws.searchJobs(query, { profileId, limit }) }),
    }),
  };
}

export function cvTools(ws: Workspace) {
  return {
    readCV: defineTool({
      name: 'readCV',
      description:
        'Read the CV for a job (one CV per job, keyed by jobId): its HTML, its CSS stylesheet and its per-CV preferences JSON. ' +
        '"exists" is false if no CV has been written yet.',
      schema: z.object({ jobId: id('Job') }),
      run: async ({ jobId }) => ws.getCv(jobId),
    }),
    writeCV: defineTool({
      name: 'writeCV',
      description:
        'Write the CV for a job. html replaces the whole CV body (semantic HTML only: no <html>, <head>, <style> or <script>). ' +
        'preferences replaces the per-CV preferences JSON (e.g. tone, length, pageSize, sectionOrder, emphasis, language). ' +
        'css replaces the stylesheet (only when asked to change the look). Omitted parts are left unchanged.',
      schema: z.object({
        jobId: id('Job'),
        html: z.string().optional().describe('Complete CV body HTML'),
        preferences: object('Complete per-CV preferences JSON').optional(),
        css: z.string().optional().describe('Complete CSS stylesheet'),
      }),
      run: async ({ jobId, html, preferences, css }, ctx) => {
        const cv = await ws.saveCv(jobId, { html, preferences, css });
        ctx.emit({ type: 'data_changed', kind: 'cv', id: jobId });
        return { ok: true, jobId, htmlChars: cv.html.length, cssChars: cv.css.length, preferences: cv.preferences };
      },
    }),
    editCV: defineTool({
      name: 'editCV',
      description:
        'Make targeted changes to an existing CV: exact find/replace edits on the HTML and/or CSS, and path operations ' +
        '(same format as editProfile) on the per-CV preferences. Read the CV first so "find" matches exactly. All-or-nothing.',
      schema: z.object({
        jobId: id('Job'),
        htmlEdits: jsonish(z.array(textEdit)).optional().describe('Find/replace edits on the HTML'),
        cssEdits: jsonish(z.array(textEdit)).optional().describe('Find/replace edits on the CSS'),
        preferenceOps: jsonish(z.array(jsonOpSchema)).optional().describe('Path operations on the preferences JSON'),
      }),
      run: async ({ jobId, htmlEdits, cssEdits, preferenceOps }, ctx) => {
        if (!htmlEdits?.length && !cssEdits?.length && !preferenceOps?.length) throw new Error('No edits given');
        const cv = await ws.editCv(jobId, {
          htmlEdits,
          cssEdits,
          preferenceOps: preferenceOps ? toJsonOps(preferenceOps) : undefined,
        });
        ctx.emit({ type: 'data_changed', kind: 'cv', id: jobId });
        return { ok: true, jobId, htmlChars: cv.html.length, cssChars: cv.css.length, preferences: cv.preferences };
      },
    }),
    searchCVs: defineTool({
      name: 'searchCVs',
      description: 'Keyword search across all CVs (text and preferences). Returns job ids, titles, scores and snippets.',
      schema: z.object({ query: z.string().min(1), limit }),
      run: async ({ query, limit }) => ({ results: await ws.searchCvs(query, limit) }),
    }),
  };
}
