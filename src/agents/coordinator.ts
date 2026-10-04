import path from 'node:path';
import { z } from 'zod';
import { exportCv, slugify, type PdfRenderer } from '../cv/export.js';
import {
  addFacts,
  addHighlights,
  mergeContact,
  mergeSkills,
  profileCompleteness,
  removeEntry,
  upsertEntry,
} from '../domain/profile.js';
import { ENTRY_SECTIONS, JobListingInputSchema, type CvVersion } from '../domain/schemas.js';
import type { ChatClient, ChatMessage, Think, Usage } from '../llm/types.js';
import type { CvStore } from '../storage/store.js';
import type { PageFetcher } from '../web/fetchPage.js';
import { Agent, defineTool, type AgentEvent, type AgentTool } from './agent.js';
import type { WriterOutcome, WriterTask } from './cvWriter.js';
import { COORDINATOR, coordinatorPrompt } from './prompts.js';

const versionNumber = z.coerce.number().int().positive();

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

/** What the coordinator learns about a CV the app has just shown the user. */
function shownCvReport(cv: CvVersion) {
  const messages = (severity: string) => cv.verification.issues.filter((i) => i.severity === severity).map((i) => i.message);
  return {
    version: cv.version,
    status: cv.status,
    shownToUser: true,
    verification: {
      passed: cv.verification.passed,
      errors: messages('error'),
      warnings: messages('warning'),
      keywordCoverage: cv.verification.keywordCoverage,
      stats: cv.verification.stats,
    },
    changeSummary: cv.changeSummary,
    markdown: cv.markdown,
  };
}

export interface CoordinatorToolDeps {
  /** Hands a draft or revision to the cv-writer agent. */
  writeCv: (task: WriterTask) => Promise<WriterOutcome>;
  /** Shows a CV version to the user exactly as stored. */
  showCv: (cv: CvVersion) => void;
  fetchPage?: PageFetcher;
  /** Renders PDFs on approval; without it only Markdown and HTML are exported. */
  pdf?: PdfRenderer;
}

export function createCoordinatorTools(store: CvStore, deps: CoordinatorToolDeps): AgentTool[] {
  const tools: AgentTool[] = [
    // ---------- profile ----------
    defineTool({
      name: 'get_profile',
      description: 'Read the full user profile, plus what is still missing for a strong CV.',
      parameters: z.object({}),
      readOnly: true,
      async run() {
        const profile = await store.getProfile();
        return { profile, completeness: profileCompleteness(profile) };
      },
    }),
    defineTool({
      name: 'update_contact',
      description: 'Set contact details. Only the fields given are changed; links are added to the existing list.',
      parameters: z.object({
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        location: z.string().optional().describe('City and country, e.g. "Manchester, UK"'),
        links: z.array(z.string()).optional().describe('Portfolio, GitHub, LinkedIn URLs'),
      }),
      async run(args) {
        return (await store.updateProfile('update_contact', args, (p) => mergeContact(p, args))).contact;
      },
    }),
    defineTool({
      name: 'set_headline',
      description: "Record the user's career goal / target role in their own words.",
      parameters: z.object({ headline: z.string().min(1) }),
      async run({ headline }) {
        await store.updateProfile('set_headline', { headline }, (p) => ({ ...p, headline }));
        return 'Saved.';
      },
    }),
    defineTool({
      name: 'upsert_profile_entry',
      description:
        'Create a profile entry (omit id; section and title required) or update one (give its id; only the fields given are replaced, arrays included). Returns the entry with its id.',
      parameters: z.object({
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
      }),
      async run(args) {
        let result!: ReturnType<typeof upsertEntry>;
        await store.updateProfile('upsert_profile_entry', args, (p) => {
          result = upsertEntry(p, args, (section) => store.newId(section));
          return result.profile;
        });
        return { created: result.created, entry: result.entry };
      },
    }),
    defineTool({
      name: 'add_highlights',
      description: 'Append achievements to an existing profile entry (duplicates are ignored).',
      parameters: z.object({ entryId: z.string(), highlights: z.array(z.string()).min(1) }),
      async run({ entryId, highlights }) {
        const profile = await store.updateProfile('add_highlights', { entryId, highlights }, (p) =>
          addHighlights(p, entryId, highlights),
        );
        return profile.entries.find((e) => e.id === entryId);
      },
    }),
    defineTool({
      name: 'remove_profile_entry',
      description: 'Delete a profile entry the user says is wrong or should never be used.',
      parameters: z.object({ entryId: z.string() }),
      async run({ entryId }) {
        await store.updateProfile('remove_profile_entry', { entryId }, (p) => removeEntry(p, entryId));
        return `Removed ${entryId}.`;
      },
    }),
    defineTool({
      name: 'add_skills',
      description:
        'Add skills under a category such as "Languages", "Frameworks", "Cloud" or "Spoken languages" (merged, de-duplicated).',
      parameters: z.object({ category: z.string().min(1), items: z.array(z.string()).min(1) }),
      async run({ category, items }) {
        return (await store.updateProfile('add_skills', { category, items }, (p) => mergeSkills(p, category, items))).skills;
      },
    }),
    defineTool({
      name: 'add_facts',
      description:
        'Remember other facts about the user: right to work, availability, spelling preference, things to keep off the CV, ...',
      parameters: z.object({ facts: z.array(z.string()).min(1) }),
      async run({ facts }) {
        return (await store.updateProfile('add_facts', { facts }, (p) => addFacts(p, facts))).facts;
      },
    }),

    // ---------- job listings ----------
    defineTool({
      name: 'save_job_listing',
      description: 'Save a job listing. description must be the full listing text, verbatim. Returns the job id.',
      parameters: JobListingInputSchema,
      async run(args) {
        const job = await store.saveJob(args);
        return { jobId: job.id, title: job.title, company: job.company };
      },
    }),
    defineTool({
      name: 'list_job_listings',
      description: 'List saved job listings with their CV progress.',
      parameters: z.object({}),
      readOnly: true,
      async run() {
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
      },
    }),
    defineTool({
      name: 'get_job_listing',
      description: 'Read a saved job listing in full.',
      parameters: z.object({ jobId: z.string() }),
      readOnly: true,
      async run({ jobId }) {
        const job = await store.getJob(jobId);
        if (!job) throw new Error(`No job listing "${jobId}"`);
        return job;
      },
    }),

    // ---------- CVs ----------
    defineTool({
      name: 'write_cv',
      description:
        'Have the CV writer draft a CV for a saved job, or revise an existing version. The finished CV is shown to the user automatically; you get back the version number, its verification report and the writer\'s notes. Takes a minute or two.',
      parameters: z.object({
        jobId: z.string(),
        basedOnVersion: versionNumber.optional().describe('Version to revise; omit for a fresh draft'),
        feedback: z.string().optional().describe("The user's feedback on that version, verbatim"),
        notes: z.string().optional().describe('Anything else the writer should know, e.g. "keep it to one page"'),
      }),
      async run(task) {
        const outcome = await deps.writeCv(task);
        if (!outcome.version) {
          throw new Error(`The CV writer did not save a CV. Its reply: ${outcome.reply || '(none)'}`);
        }
        deps.showCv(outcome.version);
        return {
          ...shownCvReport(outcome.version),
          writerNotes: outcome.reply,
          intermediateVersions: outcome.savedVersions.slice(0, -1),
          note: 'The CV has been shown to the user in full. Do not repeat it; summarise the checks and ask for feedback.',
        };
      },
    }),
    defineTool({
      name: 'list_cv_versions',
      description: 'List every CV iteration for a job, oldest first.',
      parameters: z.object({ jobId: z.string() }),
      readOnly: true,
      async run({ jobId }) {
        return (await store.listCvVersions(jobId)).map(versionSummary);
      },
    }),
    defineTool({
      name: 'show_cv',
      description: 'Show the user a CV version exactly as stored (latest if version is omitted), and read its verification report.',
      parameters: z.object({ jobId: z.string(), version: versionNumber.optional() }),
      readOnly: true,
      async run({ jobId, version }) {
        const cv = await store.getCvVersion(jobId, version);
        if (!cv) throw new Error(version ? `No version ${version} for job "${jobId}"` : `No CV versions for job "${jobId}" yet`);
        deps.showCv(cv);
        return { ...shownCvReport(cv), note: 'Shown to the user in full. Do not repeat it.' };
      },
    }),
    defineTool({
      name: 'approve_cv',
      description:
        'Mark a CV version as approved by the user and export the submission files (Markdown, HTML and PDF). Refused if the version has verification errors.',
      parameters: z.object({ jobId: z.string(), version: versionNumber }),
      async run({ jobId, version }) {
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
    }),
  ];

  if (deps.fetchPage) {
    const fetchPage = deps.fetchPage;
    tools.push(
      defineTool({
        name: 'fetch_job_posting',
        description: 'Fetch the text of a job posting from a URL the user gave. Save it with save_job_listing afterwards.',
        parameters: z.object({ url: z.string() }),
        readOnly: true,
        async run({ url }) {
          return fetchPage(url);
        },
      }),
    );
  }
  return tools;
}

export interface CoordinatorDeps extends CoordinatorToolDeps {
  store: CvStore;
  client: ChatClient;
  model: string;
  think?: Think;
  history?: ChatMessage[];
  onEvent?: (event: AgentEvent) => void;
  usage?: Usage;
  today?: string;
}

/** The agent the user talks to. Its tools are its whole capability set: it cannot save CV versions itself. */
export function createCoordinator(deps: CoordinatorDeps): Agent {
  return new Agent({
    name: COORDINATOR,
    model: deps.model,
    client: deps.client,
    systemPrompt: coordinatorPrompt(deps.today ?? new Date().toDateString()),
    tools: createCoordinatorTools(deps.store, deps),
    maxSteps: 16,
    audit: (event) => deps.store.audit(event),
    ...(deps.think !== undefined ? { think: deps.think } : {}),
    ...(deps.history ? { history: deps.history } : {}),
    ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
    ...(deps.usage ? { usage: deps.usage } : {}),
  });
}
