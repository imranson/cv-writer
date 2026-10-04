import { z } from 'zod';
import { ChatMessageSchema, UsageSchema } from '../llm/types.js';

// ---------- Profile (the user's career record, grown over many sessions) ----------

export const ENTRY_SECTIONS = [
  'education',
  'experience',
  'project',
  'certification',
  'award',
  'publication',
  'volunteering',
  'other',
] as const;
export type EntrySection = (typeof ENTRY_SECTIONS)[number];

export const ContactSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  links: z.array(z.string()).default([]),
});
export type Contact = z.infer<typeof ContactSchema>;

export const ProfileEntrySchema = z.object({
  id: z.string(),
  section: z.enum(ENTRY_SECTIONS),
  /** Role, degree, project name, award name, ... */
  title: z.string(),
  /** Employer, institution, client, issuer, ... */
  organisation: z.string().optional(),
  location: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  summary: z.string().optional(),
  /** Concrete achievements, ideally with outcomes and numbers. */
  highlights: z.array(z.string()).default([]),
  /** Technologies or skills exercised in this entry. */
  skills: z.array(z.string()).default([]),
});
export type ProfileEntry = z.infer<typeof ProfileEntrySchema>;

export const SkillGroupSchema = z.object({
  category: z.string(),
  items: z.array(z.string()),
});
export type SkillGroup = z.infer<typeof SkillGroupSchema>;

export const ProfileSchema = z.object({
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  contact: ContactSchema,
  /** Career goals / target roles in the user's words. */
  headline: z.string().optional(),
  entries: z.array(ProfileEntrySchema),
  skills: z.array(SkillGroupSchema),
  /** Anything else worth remembering: right to work, preferences, spelling locale, ... */
  facts: z.array(z.string()),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ProfileHistoryRecordSchema = z.object({
  revision: z.number().int(),
  at: z.string(),
  operation: z.string(),
  payload: z.unknown(),
  snapshot: ProfileSchema,
});
export type ProfileHistoryRecord = z.infer<typeof ProfileHistoryRecordSchema>;

// ---------- Job listing ----------

export const JobListingInputSchema = z.object({
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().optional(),
  url: z.string().optional(),
  /** The full listing text, verbatim. */
  description: z.string().min(1),
  requirements: z.array(z.string()).default([]),
  /** Skills / terms an applicant tracking system is likely to look for. */
  keywords: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type JobListingInput = z.input<typeof JobListingInputSchema>;

export const JobListingSchema = JobListingInputSchema.extend({
  id: z.string(),
  createdAt: z.string(),
});
export type JobListing = z.infer<typeof JobListingSchema>;

// ---------- CV document (structured output of the cv-writer agent) ----------

export const CvEntrySchema = z.object({
  /** Bold lead, e.g. "Research Intern — Privacy-Preserving Clinical Note Generation". */
  heading: z.string().min(1),
  /** Organisation / institution. */
  subheading: z.string().optional(),
  dates: z.string().optional(),
  bullets: z.array(z.string()).default([]),
  /** Ids of the profile entries this CV entry is grounded in. */
  sourceIds: z.array(z.string()).default([]),
});
export type CvEntry = z.infer<typeof CvEntrySchema>;

export const CvSectionSchema = z.object({
  title: z.string().min(1),
  paragraph: z.string().optional(),
  /** Simple list lines, e.g. "**Languages:** Python, SQL". */
  items: z.array(z.string()).default([]),
  entries: z.array(CvEntrySchema).default([]),
});
export type CvSection = z.infer<typeof CvSectionSchema>;

export const CvDocumentSchema = z.object({
  name: z.string().min(1),
  /** Contact items, rendered joined by " · ". Markdown links allowed. */
  contactLine: z.array(z.string()).default([]),
  sections: z.array(CvSectionSchema).min(1),
});
export type CvDocument = z.infer<typeof CvDocumentSchema>;

// ---------- Verification ----------

export const VerificationIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
});
export type VerificationIssue = z.infer<typeof VerificationIssueSchema>;

export const VerificationReportSchema = z.object({
  passed: z.boolean(),
  issues: z.array(VerificationIssueSchema),
  keywordCoverage: z.object({ matched: z.array(z.string()), missing: z.array(z.string()) }),
  stats: z.object({ wordCount: z.number(), bulletCount: z.number(), estimatedPages: z.number() }),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

// ---------- CV version (one stored iteration) ----------

export const CvExportsSchema = z.object({
  markdown: z.string(),
  html: z.string(),
  pdf: z.string().optional(),
});
export type CvExports = z.infer<typeof CvExportsSchema>;

export const CvVersionSchema = z.object({
  jobId: z.string(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  status: z.enum(['draft', 'approved']),
  /** Profile revision the CV was written against; resolve via profile history. */
  profileRevision: z.number().int().nonnegative(),
  basedOnVersion: z.number().int().positive().optional(),
  /** User feedback this iteration addresses, verbatim. */
  feedback: z.string().optional(),
  /** The cv-writer run that produced it; see writer-runs/<id>.json for the full transcript. */
  writerRunId: z.string().optional(),
  changeSummary: z.string(),
  document: CvDocumentSchema,
  markdown: z.string(),
  verification: VerificationReportSchema,
  approvedAt: z.string().optional(),
  exports: CvExportsSchema.optional(),
});
export type CvVersion = z.infer<typeof CvVersionSchema>;

// ---------- Audit log ----------

export const AuditEventSchema = z.object({
  at: z.string(),
  actor: z.string(),
  action: z.string(),
  ok: z.boolean(),
  detail: z.unknown().optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ---------- Conversations (stored for resuming and auditing) ----------

export const SessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  model: z.string(),
  writerModel: z.string(),
  /** The coordinator's full conversation, tool calls and results included (system prompt excluded). */
  messages: z.array(ChatMessageSchema),
  usage: UsageSchema,
});
export type Session = z.infer<typeof SessionSchema>;

export const WriterRunSchema = z.object({
  id: z.string(),
  sessionId: z.string().optional(),
  jobId: z.string(),
  model: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  outcome: z.enum(['saved', 'no-cv', 'failed']),
  /** CV versions saved during the run, in order. */
  savedVersions: z.array(z.number().int().positive()),
  /** The writer's closing message to the coordinator. */
  reply: z.string(),
  error: z.string().optional(),
  systemPrompt: z.string(),
  messages: z.array(ChatMessageSchema),
  usage: UsageSchema,
});
export type WriterRun = z.infer<typeof WriterRunSchema>;
