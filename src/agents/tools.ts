import path from 'node:path';
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { exportCv, slugify, type PdfRenderer } from '../cv/export.js';
import { renderMarkdown } from '../cv/render.js';
import { verifyCv } from '../cv/verify.js';
import {
  addFacts,
  addHighlights,
  mergeContact,
  mergeSkills,
  profileCompleteness,
  removeEntry,
  upsertEntry,
} from '../domain/profile.js';
import { CvDocumentSchema, ENTRY_SECTIONS, JobListingInputSchema, type CvVersion } from '../domain/schemas.js';
import type { CvStore } from '../storage/store.js';
import { CV_WRITER_AGENT } from './prompts.js';

export const MCP_SERVER_NAME = 'cv';

/** Which agent may call a tool. Enforced by the PreToolUse policy hook. */
export type ToolOwner = 'coordinator' | typeof CV_WRITER_AGENT | 'shared';

export interface CvTool {
  owner: ToolOwner;
  definition: SdkMcpToolDefinition<any>;
}

export const mcpToolName = (name: string) => `mcp__${MCP_SERVER_NAME}__${name}`;

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

function versionSummary(cv: CvVersion) {
  const count = (severity: string) => cv.verification.issues.filter((i) => i.severity === severity).length;
  return {
    version: cv.version,
    status: cv.status,
    createdAt: cv.createdAt,
    basedOnVersion: cv.basedOnVersion,
    feedback: cv.feedback,
    changeSummary: cv.changeSummary,
    verificationPassed: cv.verification.passed,
    errors: count('error'),
    warnings: count('warning'),
  };
}

export interface ToolDeps {
  /** Renders PDFs on approval; when absent only Markdown and HTML are exported. */
  pdf?: PdfRenderer;
}

export function createCvTools(store: CvStore, deps: ToolDeps = {}): CvTool[] {
  const tools: CvTool[] = [];

  /** Registers a tool; mutating tools are written to the audit log, failures become tool errors. */
  function define<Shape extends z.ZodRawShape>(
    owner: ToolOwner,
    name: string,
    description: string,
    shape: Shape,
    run: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
    opts: { readOnly?: boolean } = {},
  ) {
    const definition = tool(
      name,
      description,
      shape,
      async (args) => {
        try {
          const result = await run(args as z.infer<z.ZodObject<Shape>>);
          if (!opts.readOnly) await store.audit({ actor: owner, action: name, ok: true, detail: { input: args } });
          return ok(result);
        } catch (err) {
          const message = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
          await store.audit({ actor: owner, action: name, ok: false, detail: { input: args, error: message } });
          return fail(`${name} failed: ${message}`);
        }
      },
      { annotations: { readOnlyHint: opts.readOnly ?? false } },
    );
    tools.push({ owner, definition });
  }

  // ---------- profile ----------

  define('shared', 'get_profile', 'Read the full user profile, plus what is still missing for a strong CV.', {}, async () => {
    const profile = await store.getProfile();
    return { profile, completeness: profileCompleteness(profile) };
  }, { readOnly: true });

  define(
    'coordinator',
    'update_contact',
    'Set contact details. Only the fields given are changed; links are added to the existing list.',
    {
      name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      location: z.string().optional().describe('City and country, e.g. "Manchester, UK"'),
      links: z.array(z.string()).optional().describe('Portfolio, GitHub, LinkedIn URLs'),
    },
    async (args) => (await store.updateProfile('update_contact', args, (p) => mergeContact(p, args))).contact,
  );

  define(
    'coordinator',
    'set_headline',
    "Record the user's career goal / target role in their own words.",
    { headline: z.string().min(1) },
    async ({ headline }) => {
      await store.updateProfile('set_headline', { headline }, (p) => ({ ...p, headline }));
      return 'Saved.';
    },
  );

  define(
    'coordinator',
    'upsert_profile_entry',
    'Create a profile entry (omit id; section and title required) or update one (give its id; only the fields given are replaced, arrays included). Returns the entry with its id.',
    {
      id: z.string().optional().describe('Existing entry id to update'),
      section: z.enum(ENTRY_SECTIONS).optional(),
      title: z.string().optional().describe('Role, degree, project name, award, ...'),
      organisation: z.string().optional().describe('Employer, institution, client or issuer'),
      location: z.string().optional(),
      startDate: z.string().optional().describe('As the user says it, e.g. "Sept 2023"'),
      endDate: z.string().optional().describe('e.g. "June 2026" or "Present"'),
      summary: z.string().optional(),
      highlights: z.array(z.string()).optional().describe('Concrete achievements, with outcomes and numbers'),
      skills: z.array(z.string()).optional().describe('Technologies and skills used'),
    },
    async (args) => {
      let result!: ReturnType<typeof upsertEntry>;
      await store.updateProfile('upsert_profile_entry', args, (p) => {
        result = upsertEntry(p, args, (section) => store.newId(section));
        return result.profile;
      });
      return { created: result.created, entry: result.entry };
    },
  );

  define(
    'coordinator',
    'add_highlights',
    'Append achievements to an existing profile entry (duplicates are ignored).',
    { entryId: z.string(), highlights: z.array(z.string()).min(1) },
    async ({ entryId, highlights }) => {
      const profile = await store.updateProfile('add_highlights', { entryId, highlights }, (p) =>
        addHighlights(p, entryId, highlights),
      );
      return profile.entries.find((e) => e.id === entryId);
    },
  );

  define(
    'coordinator',
    'remove_profile_entry',
    'Delete a profile entry the user says is wrong or should never be used.',
    { entryId: z.string() },
    async ({ entryId }) => {
      await store.updateProfile('remove_profile_entry', { entryId }, (p) => removeEntry(p, entryId));
      return `Removed ${entryId}.`;
    },
  );

  define(
    'coordinator',
    'add_skills',
    'Add skills under a category such as "Languages", "Frameworks", "Cloud" or "Spoken languages" (merged, de-duplicated).',
    { category: z.string().min(1), items: z.array(z.string()).min(1) },
    async ({ category, items }) =>
      (await store.updateProfile('add_skills', { category, items }, (p) => mergeSkills(p, category, items))).skills,
  );

  define(
    'coordinator',
    'add_facts',
    'Remember other facts about the user: right to work, availability, spelling preference, things to keep off the CV, ...',
    { facts: z.array(z.string()).min(1) },
    async ({ facts }) => (await store.updateProfile('add_facts', { facts }, (p) => addFacts(p, facts))).facts,
  );

  // ---------- job listings ----------

  define(
    'coordinator',
    'save_job_listing',
    'Save a job listing. description must be the full listing text, verbatim. Returns the job id.',
    JobListingInputSchema.shape,
    async (args) => {
      const job = await store.saveJob(args);
      return { jobId: job.id, title: job.title, company: job.company };
    },
  );

  define('shared', 'list_job_listings', 'List saved job listings with their CV progress.', {}, async () => {
    const jobs = await store.listJobs();
    return Promise.all(
      jobs.map(async (job) => {
        const versions = await store.listCvVersions(job.id);
        return {
          jobId: job.id,
          title: job.title,
          company: job.company,
          savedAt: job.createdAt,
          cvVersions: versions.length,
          approvedVersions: versions.filter((v) => v.status === 'approved').map((v) => v.version),
        };
      }),
    );
  }, { readOnly: true });

  define('shared', 'get_job_listing', 'Read a saved job listing in full.', { jobId: z.string() }, async ({ jobId }) => {
    const job = await store.getJob(jobId);
    if (!job) throw new Error(`No job listing "${jobId}"`);
    return job;
  }, { readOnly: true });

  // ---------- CV versions ----------

  define(
    'shared',
    'list_cv_versions',
    'List every CV iteration for a job, oldest first.',
    { jobId: z.string() },
    async ({ jobId }) => (await store.listCvVersions(jobId)).map(versionSummary),
    { readOnly: true },
  );

  define(
    'shared',
    'get_cv_version',
    'Read a CV version (latest if version is omitted) with its verification report. format "markdown" (default) returns the rendered CV to show the user; "structured" returns the document JSON for revising it.',
    {
      jobId: z.string(),
      version: z.number().int().positive().optional(),
      format: z.enum(['markdown', 'structured']).optional(),
    },
    async ({ jobId, version, format }) => {
      const cv = await store.getCvVersion(jobId, version);
      if (!cv) throw new Error(version ? `No version ${version} for job "${jobId}"` : `No CV versions for job "${jobId}" yet`);
      const header = { ...versionSummary(cv), verification: cv.verification, exports: cv.exports };
      if (format === 'structured') return { ...header, document: cv.document };
      return `${JSON.stringify(header, null, 2)}\n\n----- CV (Markdown) -----\n\n${cv.markdown}`;
    },
    { readOnly: true },
  );

  define(
    CV_WRITER_AGENT,
    'save_cv_version',
    'Save a new CV iteration for a job. It is verified against the profile and job; the response lists the version number and any issues to fix.',
    {
      jobId: z.string(),
      document: CvDocumentSchema,
      changeSummary: z.string().min(1).describe('What this version does and why (tailoring choices, changes from the base version)'),
      basedOnVersion: z.number().int().positive().optional().describe('Version this revises'),
      feedback: z.string().optional().describe('The user feedback this version addresses, verbatim'),
    },
    async ({ jobId, document, changeSummary, basedOnVersion, feedback }) => {
      const job = await store.getJob(jobId);
      if (!job) throw new Error(`No job listing "${jobId}"`);
      if (basedOnVersion && !(await store.getCvVersion(jobId, basedOnVersion))) {
        throw new Error(`basedOnVersion ${basedOnVersion} does not exist for job "${jobId}"`);
      }
      const doc = CvDocumentSchema.parse(document);
      const profile = await store.getProfile();
      const saved = await store.saveCvVersion({
        jobId,
        profileRevision: profile.revision,
        changeSummary,
        document: doc,
        markdown: renderMarkdown(doc),
        verification: verifyCv(doc, profile, job),
        ...(basedOnVersion ? { basedOnVersion } : {}),
        ...(feedback ? { feedback } : {}),
      });
      return {
        version: saved.version,
        verificationPassed: saved.verification.passed,
        issues: saved.verification.issues,
        keywordCoverage: saved.verification.keywordCoverage,
        stats: saved.verification.stats,
      };
    },
  );

  define(
    'coordinator',
    'approve_cv',
    'Mark a CV version as approved by the user and export the submission files (Markdown, HTML and PDF). Refused if the version has verification errors.',
    { jobId: z.string(), version: z.number().int().positive() },
    async ({ jobId, version }) => {
      const cv = await store.getCvVersion(jobId, version);
      if (!cv) throw new Error(`No version ${version} for job "${jobId}"`);
      if (!cv.verification.passed) {
        const errors = cv.verification.issues.filter((i) => i.severity === 'error').map((i) => i.message);
        throw new Error(`Version ${version} has verification errors and cannot be approved:\n- ${errors.join('\n- ')}`);
      }
      const { exports, warnings } = await exportCv({
        doc: cv.document,
        outDir: path.join(store.outputDir, jobId),
        baseName: `${slugify(cv.document.name)}-cv-v${version}`,
        ...(deps.pdf ? { pdf: deps.pdf } : {}),
      });
      await store.approveCvVersion(jobId, version, exports);
      return { approved: true, files: exports, warnings };
    },
  );

  return tools;
}

export function createCvMcpServer(tools: CvTool[]) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    alwaysLoad: true,
    tools: tools.map((t) => t.definition),
  });
}
