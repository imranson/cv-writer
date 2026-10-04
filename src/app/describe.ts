import { CV_WRITER_AGENT } from '../agents/prompts.js';
import { MCP_SERVER_NAME } from '../agents/tools.js';

type Input = Record<string, unknown>;
const str = (v: unknown, fallback = '') => (typeof v === 'string' && v.trim() ? v : fallback);

const LABELS: Record<string, (input: Input) => string> = {
  get_profile: () => 'Reading your profile',
  update_contact: () => 'Saving your contact details',
  set_headline: () => 'Saving your career goal',
  upsert_profile_entry: (i) => (i.id ? `Updating "${str(i.title, str(i.id))}" in your profile` : `Adding "${str(i.title, 'entry')}" to your profile`),
  add_highlights: () => 'Adding achievements to your profile',
  remove_profile_entry: () => 'Removing an entry from your profile',
  add_skills: (i) => `Saving ${str(i.category, 'your')} skills`,
  add_facts: () => 'Noting that down',
  save_job_listing: (i) => `Saving the ${str(i.title, 'job')} listing${i.company ? ` at ${str(i.company)}` : ''}`,
  list_job_listings: () => 'Looking up your saved job listings',
  get_job_listing: () => 'Reading the job listing',
  list_cv_versions: () => 'Looking up CV versions',
  get_cv_version: (i) => `Opening CV ${typeof i.version === 'number' ? `version ${i.version}` : 'draft'}`,
  save_cv_version: () => 'Saving a CV draft and running checks',
  approve_cv: (i) => `Approving version ${String(i.version)} and exporting files`,
  Agent: () => 'Handing over to the CV writer — this can take a few minutes',
  Task: () => 'Handing over to the CV writer — this can take a few minutes',
  WebFetch: (i) => `Fetching ${str(i.url, 'the page')}`,
};

/** A one-line, user-facing description of a tool call, or undefined for calls not worth showing. */
export function describeToolUse(toolName: string, input: unknown, fromSubagent = false): string | undefined {
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  const name = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
  const label = LABELS[name]?.((input ?? {}) as Input);
  if (!label) return undefined;
  return fromSubagent ? `${CV_WRITER_AGENT}: ${label}` : label;
}
