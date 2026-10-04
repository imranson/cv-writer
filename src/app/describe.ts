import type { AgentEvent } from '../agents/agent.js';
import { CV_WRITER } from '../agents/prompts.js';

type Args = Record<string, unknown>;
const str = (v: unknown, fallback = '') => (typeof v === 'string' && v.trim() ? v : fallback);

const LABELS: Record<string, (args: Args) => string> = {
  get_profile: () => 'Reading your profile',
  update_contact: () => 'Saving your contact details',
  set_headline: () => 'Saving your career goal',
  upsert_profile_entry: (a) => (a.id ? `Updating "${str(a.title, str(a.id))}" in your profile` : `Adding "${str(a.title, 'entry')}" to your profile`),
  add_highlights: () => 'Adding achievements to your profile',
  remove_profile_entry: () => 'Removing an entry from your profile',
  add_skills: (a) => `Saving ${str(a.category, 'your')} skills`,
  add_facts: () => 'Noting that down',
  save_job_listing: (a) => `Saving the ${str(a.title, 'job')} listing${a.company ? ` at ${str(a.company)}` : ''}`,
  list_job_listings: () => 'Looking up your saved job listings',
  get_job_listing: () => 'Reading the job listing',
  fetch_job_posting: (a) => `Fetching ${str(a.url, 'the job posting')}`,
  write_cv: (a) =>
    a.basedOnVersion
      ? `Handing your feedback on version ${String(a.basedOnVersion)} to the CV writer, this can take a minute or two`
      : 'Handing over to the CV writer, this can take a minute or two',
  list_cv_versions: () => 'Looking up CV versions',
  show_cv: (a) => `Opening CV ${typeof a.version === 'number' ? `version ${a.version}` : 'draft'}`,
  approve_cv: (a) => `Approving version ${String(a.version)} and exporting files`,
  save_cv_version: () => 'Saving a draft and running checks',
};

/** A one-line, user-facing description of a tool call, or undefined for calls not worth showing. */
export function describeToolCall(name: string, args: Args, agent?: string): string | undefined {
  const label = LABELS[name]?.(args);
  if (!label) return undefined;
  return agent === CV_WRITER ? `${CV_WRITER}: ${label}` : label;
}

/** Progress worth surfacing from a tool's result (the writer's self-checks). */
export function describeToolResult(event: Extract<AgentEvent, { type: 'tool-result' }>): string | undefined {
  if (event.name !== 'save_cv_version' || !event.ok) return undefined;
  try {
    const result = JSON.parse(event.output) as { version: number; verificationPassed: boolean; issues: Array<{ severity: string }> };
    const errors = result.issues.filter((i) => i.severity === 'error').length;
    const warnings = result.issues.length - errors;
    const checks = result.verificationPassed
      ? `checks passed${warnings ? ` with ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`
      : `${errors} error${errors === 1 ? '' : 's'} to fix`;
    return `${CV_WRITER}: saved version ${result.version} (${checks})`;
  } catch {
    return undefined;
  }
}
