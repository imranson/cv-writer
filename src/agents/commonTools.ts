import { z } from 'zod';
import { runChecks, type CheckFinding } from '../cv/checks.ts';
import type { SkillLibrary } from '../skills/library.ts';
import type { Store } from '../storage/store.ts';
import { htmlToText, wordCount } from '../util/text.ts';
import type { AgentName } from './events.ts';
import { defineTool, ToolError, type AgentTool } from './tool.ts';

export function skillTools(skills: SkillLibrary, audience: AgentName): AgentTool[] {
  return [
    defineTool({
      name: 'list_skills',
      description: 'List the expert CV-writing/critique skills (advice documents) available to you, with descriptions.',
      schema: z.object({}),
      async run() {
        const list = await skills.list(audience);
        if (!list.length) return 'No skills available.';
        return list.map((s) => `- ${s.id} — ${s.name}: ${s.description}`).join('\n');
      },
    }),
    defineTool({
      name: 'read_skill',
      description: 'Read the full text of an expert skill by id (see the skills index in your instructions or list_skills).',
      schema: z.object({ id: z.string().describe('Skill id, e.g. "achievement-bullets"') }),
      async run({ id }) {
        const skill = await skills.get(id.trim());
        if (!skill) throw new ToolError(`No skill with id "${id}". Call list_skills to see available ids.`);
        return `# ${skill.name}\n\n${skill.body}`;
      },
    }),
  ];
}

export function readProfileTool(store: Store): AgentTool {
  return defineTool({
    name: 'read_profile',
    description: "Read the candidate's profile (markdown): the source of truth for all facts, plus their preferences.",
    schema: z.object({}),
    async run() {
      const profile = await store.readProfile();
      return profile.trim() ? profile : '(The profile is empty.)';
    },
  });
}

/** Replace exactly one occurrence of `find` (or all of them when `replaceAll`). */
export function applyEdit(text: string, find: string, replace: string, replaceAll = false): string {
  if (!find) throw new ToolError('"find" must not be empty');
  const count = text.split(find).length - 1;
  if (count === 0) throw new ToolError('The "find" text was not found. Re-read the current content and copy the text exactly.');
  if (count > 1 && !replaceAll) {
    throw new ToolError(`The "find" text occurs ${count} times. Include more surrounding text to make it unique, or set replace_all.`);
  }
  return replaceAll ? text.split(find).join(replace) : text.replace(find, () => replace);
}

export function formatFindings(findings: CheckFinding[]): string {
  const relevant = findings.filter((f) => f.severity !== 'info');
  const info = findings.filter((f) => f.severity === 'info').map((f) => f.message);
  if (!relevant.length) return `Automated checks: no problems found. ${info.join(' ')}`.trim();
  return `Automated checks:\n${relevant.map((f) => `- [${f.severity}] ${f.message}`).join('\n')}\n${info.join(' ')}`.trim();
}

/** Plain-text view of a CV for agents: shorter than HTML and easier to reason about. */
export async function describeCv(store: Store, jobId: string, format: 'text' | 'html' = 'text'): Promise<string> {
  const html = await store.readCv(jobId);
  if (!html?.trim()) return '(No CV has been written for this job yet.)';
  if (format === 'html') return html;
  const text = htmlToText(html);
  return `${text}\n\n(${wordCount(text)} words)`;
}

export async function checkCv(store: Store, jobId: string, pageCount?: number): Promise<CheckFinding[]> {
  const html = (await store.readCv(jobId)) ?? '';
  return runChecks(html, { profile: await store.readProfile(), pageCount });
}
