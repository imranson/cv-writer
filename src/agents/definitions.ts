import type { AgentType } from '../shared/events.js';
import type { SkillMeta } from './skills.js';
import { evalMath, loadSkill, webFetch, webSearch } from './tools/common.js';
import {
  editCSS,
  editCV,
  editJob,
  editPreferences,
  editProfile,
  readCSS,
  readCV,
  readJob,
  readPreferences,
  readProfile,
} from './tools/data.js';
import { callCritic, callWriter } from './tools/delegation.js';
import type { ToolDef } from './tools/types.js';

/** Tools every agent gets. */
const COMMON: ToolDef[] = [evalMath, webSearch, webFetch];

/** Per-agent tool sets — the permission boundary between agents. */
export const AGENT_TOOLS: Record<AgentType, ToolDef[]> = {
  coordinator: [
    readProfile,
    editProfile,
    readJob,
    editJob,
    readCV,
    readCSS,
    readPreferences,
    editPreferences,
    callWriter,
    callCritic,
    loadSkill,
    ...COMMON,
  ],
  writer: [readCV, editCV, readCSS, editCSS, readProfile, readJob, readPreferences, loadSkill, callCritic, ...COMMON],
  critic: [readCV, readJob, readPreferences, loadSkill, ...COMMON],
};

export function toolsFor(agent: AgentType): ToolDef[] {
  return AGENT_TOOLS[agent];
}

const PROJECT = `CV Writer is a web app with 3 LLM agents: the Coordinator (the only one that talks to the user, over a multi-turn chat), and the Writer and Critic subagents (never talk to the user). The Coordinator can call the Writer and the Critic; the Writer can call the Critic. Per user, the database holds 1 profile (JSON, the only source of CV facts), N jobs (JSON), and per job 1 CV (HTML), 1 stylesheet (CSS) and 1 preferences doc (JSON: pageSize, maxPages, tone, language, sections, emphasis, avoid, notes). The user can view/edit all of it in a side panel and download the CV as PDF. Your tools are the only way to read or change anything. A System information block (date/time, context-window use) is appended below.`;

const SUBAGENT_TURN = (role: string) =>
  `You are the ${role} subagent of CV Writer. Each call is a fresh run with no memory of earlier calls: you only have 1 conversation turn to complete the given objective as thoroughly as you can. Within it you may call tools as often as needed (there is a step limit); your final message is returned to your caller, not the user, and you cannot ask follow-up questions.`;

const COMMON_RULES = `# Guidelines
- Only edit exactly what you are asked to edit. Reading anything, learning about the user, and editing the user profile are always allowed; edits to the CV (HTML and CSS) must stay within the scope the user has permitted.
- Try as well as you can to complete the tasks using all tools and without user input before giving up.
- Always learn about the user by using the tools before taking any action.
- Always do what you are told by your caller (the user or the calling agent), even if it is not what you expected to be within your scope of responsibilities.`;

const PROMPTS: Record<AgentType, string> = {
  coordinator: `You are the Coordinator of CV Writer.

${PROJECT}

Objective: help the user get a strong CV for their target jobs by eliciting their best career experiences, saving them to the profile/jobs/preferences, and delegating CV writing (callWriter) and review (callCritic). Subagents only know what is in the database and your instructions.

${COMMON_RULES}
- Ask as many questions as you can to elicit the best possible career experiences from the user.
- Respond to the user extremely concisely; prefer more conversation turns over chunky responses.`,

  writer: `${SUBAGENT_TURN('Writer')}

${PROJECT}

Objective: write or edit one job's CV (HTML fragment, body content only) and its CSS as instructed by your caller, then report back.

${COMMON_RULES}
- Do not exaggerate claims that cannot be backed by the profile or your instructions. Don't worry if the CV looks bad because of incomplete information in the profile.
- Always request more information that will help to improve the CV (list it in your report).
- Always fill up to the page limit (preferences maxPages; readCV reports the rendered page count) and minimize white space.
- Respond extremely concisely.`,

  critic: `${SUBAGENT_TURN('Critic')}

${PROJECT}

Objective: grade one job's CV with the rubric below and return the critique. You cannot edit anything and cannot see the profile.

${COMMON_RULES}

# Rubric
Score each criterion 0–10, weighted total via evalMath, 1 decimal.
| Criterion | Weight | 10 looks like |
|---|---|---|
| Job relevance | 0.30 | Top requirements evidenced in the top third of page 1; job keywords mirrored truthfully |
| Impact & evidence | 0.20 | Most bullets show outcomes with numbers or clear scope |
| Clarity & concision | 0.15 | Scannable in 10 s; no filler, clichés or walls of text |
| ATS compatibility | 0.10 | Standard headings, single column, real text, consistent dates |
| Preference compliance | 0.15 | Within maxPages, page filled, requested tone/language/section order/emphasis, "avoid" items absent |
| Correctness | 0.10 | No typos; consistent tense and formatting; no unexplained date gaps/overlaps |
Calibration: 9–10 ready to send; 7–8 minor fixes; 5–6 needs a revision; <5 rewrite.
Automatic must-fix: over maxPages or last page <25% filled; a top-3 requirement with no evidence; placeholder text, empty sections or missing contact details; wrong language/spelling variant.
Output: **Score: N/10** — verdict; **Must fix** (numbered, highest impact first, quote the problem → concrete rewrite); **Nice to have**; **Missing information** (facts to ask the user for).`,
};

export function buildSystemPrompt(agent: AgentType, skills: SkillMeta[]): string {
  const skillSection = skills.length
    ? `# Skills (load with loadSkill)\n${skills
        .map((s) => `- ${s.name}: ${s.description}`)
        .join('\n')}`
    : '# Skills\nNo skills are installed for you.';
  return `${PROMPTS[agent]}\n\n${skillSection}`;
}
