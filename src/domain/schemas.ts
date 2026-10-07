import { z } from 'zod';

// ---------- Profile: the user's career record, added to over many conversations ----------

export const ENTRY_SECTIONS = [
  'experience',
  'education',
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
  /** Concrete achievements, ideally with outcomes and numbers, in the user's own facts. */
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
  /** Career goal / target roles, in the user's words. */
  headline: z.string().optional(),
  entries: z.array(ProfileEntrySchema).default([]),
  skills: z.array(SkillGroupSchema).default([]),
  /** Anything else worth remembering: languages, right to work, notice period, spelling locale, ... */
  facts: z.array(z.string()).default([]),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ProfileHistoryRecordSchema = z.object({
  revision: z.number().int(),
  at: z.string(),
  operation: z.string(),
  actor: z.string().optional(),
  reason: z.string().optional(),
  payload: z.unknown(),
  snapshot: ProfileSchema,
});
export type ProfileHistoryRecord = z.infer<typeof ProfileHistoryRecordSchema>;

// ---------- Job listing ----------

export const JobInputSchema = z.object({
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().optional(),
  url: z.string().optional(),
  /** The full listing text, verbatim. */
  description: z.string().min(1),
  requirements: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type JobInput = z.input<typeof JobInputSchema>;

export const JobSchema = JobInputSchema.extend({
  id: z.string(),
  createdAt: z.string(),
});
export type Job = z.infer<typeof JobSchema>;

// ---------- CV document (what the writer produces) ----------

/** Bullets may arrive as plain strings from a model; they are normalised to objects. */
export const CvBulletSchema = z.preprocess(
  (v) => (typeof v === 'string' ? { text: v } : v),
  z.object({
    text: z.string().min(1),
    /** Profile entry ids this bullet is based on. Defaults to the item's sources. */
    sources: z.array(z.string()).default([]),
  }),
);
export type CvBullet = z.infer<typeof CvBulletSchema>;

export const CvItemSchema = z.object({
  heading: z.string().min(1),
  subheading: z.string().optional(),
  location: z.string().optional(),
  dates: z.string().optional(),
  /** Profile entry ids this item is drawn from. */
  sources: z.array(z.string()).default([]),
  summary: z.string().optional(),
  bullets: z.array(CvBulletSchema).default([]),
});
export type CvItem = z.infer<typeof CvItemSchema>;

export const CvSkillGroupSchema = z.object({
  label: z.string().optional(),
  items: z.array(z.string()).min(1),
});

export const CvSectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entries'), title: z.string().min(1), items: z.array(CvItemSchema) }),
  z.object({ kind: z.literal('skills'), title: z.string().min(1), groups: z.array(CvSkillGroupSchema) }),
  z.object({ kind: z.literal('text'), title: z.string().min(1), text: z.string(), sources: z.array(z.string()).default([]) }),
]);
export type CvSection = z.infer<typeof CvSectionSchema>;

export const CvDocumentSchema = z.object({
  name: z.string().min(1),
  headline: z.string().optional(),
  contact: z
    .object({
      email: z.string().optional(),
      phone: z.string().optional(),
      location: z.string().optional(),
      links: z.array(z.string()).default([]),
    })
    .default({ links: [] }),
  summary: z.string().optional(),
  sections: z.array(CvSectionSchema).min(1),
});
export type CvDocument = z.infer<typeof CvDocumentSchema>;

// ---------- Deterministic checks and critic reviews ----------

export const CheckSchema = z.object({
  id: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  location: z.string().optional(),
});
export type Check = z.infer<typeof CheckSchema>;

export const CheckReportSchema = z.object({
  checks: z.array(CheckSchema),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  wordCount: z.number().int(),
  keywordCoverage: z.object({ matched: z.array(z.string()), missing: z.array(z.string()) }),
});
export type CheckReport = z.infer<typeof CheckReportSchema>;

const score10 = z.coerce.number().min(0).max(10);

/** Maps the many ways models spell an enum value ("Partially met", "not-met", "HIGH") onto ours. */
function lenientEnum<const T extends readonly [string, ...string[]]>(values: T, synonyms: Record<string, T[number]>, fallback?: T[number]) {
  return z.preprocess((v) => {
    if (typeof v !== 'string') return v ?? fallback;
    const key = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if ((values as readonly string[]).includes(key)) return key;
    return synonyms[key] ?? fallback ?? v;
  }, z.enum(values));
}

const CoverageStatus = lenientEnum(['met', 'partial', 'missing'] as const, {
  fully_met: 'met', yes: 'met', strong: 'met',
  partially_met: 'partial', partly_met: 'partial', partial_met: 'partial', partially: 'partial', weak: 'partial',
  not_met: 'missing', unmet: 'missing', absent: 'missing', no: 'missing', gap: 'missing', not_evidenced: 'missing',
});
const IssueSeverity = lenientEnum(['critical', 'major', 'minor'] as const, { high: 'major', medium: 'major', moderate: 'major', severe: 'critical', blocker: 'critical', low: 'minor', trivial: 'minor' }, 'minor');
const IssueCategory = lenientEnum(
  ['factual', 'mistake', 'coverage', 'impact', 'wording', 'presentation'] as const,
  {
    accuracy: 'factual', fabrication: 'factual', truthfulness: 'factual', correctness: 'factual', unsupported_claim: 'factual',
    error: 'mistake', typo: 'mistake', grammar: 'mistake', spelling: 'mistake', consistency: 'mistake', dates: 'mistake',
    relevance: 'coverage', keywords: 'coverage', keyword: 'coverage', requirements: 'coverage', tailoring: 'coverage',
    quantification: 'impact', metrics: 'impact', achievements: 'impact', strength: 'impact',
    clarity: 'wording', tone: 'wording', language: 'wording', style: 'wording',
    formatting: 'presentation', format: 'presentation', structure: 'presentation', layout: 'presentation', length: 'presentation', ordering: 'presentation',
  },
  'wording',
);

/** An issue sometimes arrives with its text under another key, or only as a suggestion. */
const IssueSchema = z.preprocess(
  (v) => {
    if (!v || typeof v !== 'object') return v;
    const i = v as Record<string, unknown>;
    const problem = i.problem ?? i.description ?? i.issue ?? i.message ?? i.detail ?? i.text ?? i.suggestion;
    return { ...i, problem };
  },
  z.object({
    severity: IssueSeverity,
    category: IssueCategory,
    location: z.string().optional(),
    problem: z.string(),
    suggestion: z.string().optional(),
  }),
);

/** What the critic agent submits. */
export const CritiqueInputSchema = z.object({
  overallScore: z.coerce.number().min(0).max(100),
  verdict: lenientEnum(['ready', 'needs_work', 'not_ready'] as const, { ready_to_submit: 'ready', ready_to_send: 'ready', needs_improvement: 'needs_work', needs_revision: 'needs_work', not_ready_to_submit: 'not_ready', reject: 'not_ready' }),
  scores: z.object({
    relevance: score10,
    impact: score10,
    clarity: score10,
    accuracy: score10,
    presentation: score10,
  }),
  requirementCoverage: z
    .array(
      z.object({
        requirement: z.string(),
        status: CoverageStatus,
        evidence: z.string().optional(),
      }),
    )
    .default([]),
  issues: z.array(IssueSchema).default([]),
  strengths: z.array(z.string()).default([]),
  /** Information only the user can supply that would make the CV stronger. */
  questionsForUser: z.array(z.string()).default([]),
  summary: z.string(),
});
export type CritiqueInput = z.infer<typeof CritiqueInputSchema>;

export const CritiqueSchema = CritiqueInputSchema.extend({
  at: z.string(),
  requestedBy: z.enum(['coordinator', 'writer']),
  runId: z.string(),
  model: z.string(),
});
export type Critique = z.infer<typeof CritiqueSchema>;

// ---------- CV style (PDF and preview) ----------

export const StyleSchema = z.object({
  fontFamily: z.string().min(1).default('georgia'),
  headingFontFamily: z.string().min(1).default('same'),
  baseFontSize: z.coerce.number().min(7).max(16).default(10.5),
  nameFontSize: z.coerce.number().min(12).max(40).default(22),
  lineHeight: z.coerce.number().min(1).max(2).default(1.3),
  pageSize: z.enum(['A4', 'Letter']).default('A4'),
  marginVerticalMm: z.coerce.number().min(5).max(40).default(15),
  marginHorizontalMm: z.coerce.number().min(5).max(40).default(17),
  sectionSpacingPt: z.coerce.number().min(0).max(30).default(11),
  itemSpacingPt: z.coerce.number().min(0).max(20).default(6),
  bulletSpacingPt: z.coerce.number().min(0).max(10).default(1.5),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #1f3a5f')
    .default('#1f3a5f'),
  headerAlign: z.enum(['left', 'center']).default('left'),
  sectionTitleStyle: z.enum(['caps-rule', 'caps', 'plain']).default('caps-rule'),
  bulletChar: z.enum(['•', '–', '▪', '›']).default('•'),
});
export type Style = z.infer<typeof StyleSchema>;
export const DEFAULT_STYLE: Style = StyleSchema.parse({});

// ---------- CV versions ----------

export const CvExportSchema = z.object({
  at: z.string(),
  pdf: z.string().optional(),
  html: z.string(),
  markdown: z.string(),
  pages: z.number().int().optional(),
  style: StyleSchema,
});
export type CvExport = z.infer<typeof CvExportSchema>;

export const CvVersionSchema = z.object({
  jobId: z.string(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  status: z.enum(['draft', 'approved']),
  /** The profile revision the writer worked from (see profile-history.jsonl). */
  profileRevision: z.number().int(),
  basedOnVersion: z.number().int().optional(),
  /** The user's feedback this version addresses, verbatim. */
  feedback: z.string().optional(),
  writerRunId: z.string(),
  changeSummary: z.string().optional(),
  document: CvDocumentSchema,
  checks: CheckReportSchema,
  critiques: z.array(CritiqueSchema).default([]),
  approvedAt: z.string().optional(),
  exports: z.array(CvExportSchema).default([]),
});
export type CvVersion = z.infer<typeof CvVersionSchema>;

// ---------- Agent runs, sessions and audit ----------

export const ToolCallSchema = z.object({
  function: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
});

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  thinking: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_name: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const UsageSchema = z.object({
  promptTokens: z.number().int().default(0),
  outputTokens: z.number().int().default(0),
  calls: z.number().int().default(0),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AgentRunSchema = z.object({
  id: z.string(),
  agent: z.enum(['writer', 'critic']),
  model: z.string(),
  requestedBy: z.string(),
  jobId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  outcome: z.enum(['running', 'completed', 'failed']),
  error: z.string().optional(),
  system: z.string(),
  brief: z.string(),
  messages: z.array(ChatMessageSchema),
  result: z.unknown().optional(),
  usage: UsageSchema,
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const TranscriptEntrySchema = z.object({
  role: z.enum(['user', 'assistant', 'event']),
  text: z.string(),
  at: z.string(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const SessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  activeJobId: z.string().optional(),
  /** The coordinator's model-facing history (system prompt excluded; it is rebuilt every turn). */
  messages: z.array(ChatMessageSchema),
  /** What the user sees. */
  transcript: z.array(TranscriptEntrySchema),
  usage: UsageSchema.default({ promptTokens: 0, outputTokens: 0, calls: 0 }),
});
export type Session = z.infer<typeof SessionSchema>;

export const AuditRecordSchema = z.object({
  at: z.string(),
  actor: z.string(),
  action: z.string(),
  outcome: z.enum(['ok', 'error', 'refused']),
  details: z.unknown().optional(),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
