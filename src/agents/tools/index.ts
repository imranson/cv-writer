import type { AgentName } from '../../config.js';
import type { Tool } from '../tool.js';
import { COMMON_TOOLS, loadSkill } from './common.js';
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
} from './data.js';
import { callCritic, callWriter } from './delegation.js';

/** Tool sets per agent. Every agent also gets evalMath, webSearch and webFetch. */
export const AGENT_TOOLS: Record<AgentName, Tool[]> = {
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
    ...COMMON_TOOLS,
  ],
  writer: [readCV, editCV, readCSS, editCSS, readProfile, readJob, readPreferences, loadSkill, callCritic, ...COMMON_TOOLS],
  critic: [readCV, readJob, readPreferences, loadSkill, ...COMMON_TOOLS],
} as Record<AgentName, Tool[]>;

export function toolNames(agent: AgentName): string[] {
  return AGENT_TOOLS[agent].map((t) => t.name);
}
