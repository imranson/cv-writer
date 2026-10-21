import { z } from 'zod';
import type { Tool } from 'ollama';
import type { AgentName } from '../../config';
import type { ToolContext, ToolDef } from '../types';
import { evalMath, loadSkill, webFetch, webSearch } from './common';
import { editCSS, editCV, editJob, editPreferences, editProfile, readCSS, readCV, readJob, readPreferences, readProfile } from './data';
import { callCritic, callWriter } from './subagents';

export const ALL_TOOLS: Record<string, ToolDef<any>> = Object.fromEntries(
  [
    readProfile,
    editProfile,
    readJob,
    editJob,
    readCV,
    editCV,
    readPreferences,
    editPreferences,
    readCSS,
    editCSS,
    callWriter,
    callCritic,
    loadSkill,
    evalMath,
    webSearch,
    webFetch,
  ].map((t) => [t.name, t]),
);

const SHARED = ['evalMath', 'webSearch', 'webFetch'];

/** Which tools each agent may call. Only the coordinator talks to the user. */
export const AGENT_TOOLS: Record<AgentName, string[]> = {
  coordinator: [
    'readProfile',
    'editProfile',
    'readJob',
    'editJob',
    'readCV',
    'readPreferences',
    'editPreferences',
    'readCSS',
    'callWriter',
    'callCritic',
    'loadSkill',
    ...SHARED,
  ],
  writer: ['readCV', 'editCV', 'readPreferences', 'readCSS', 'editCSS', 'readProfile', 'loadSkill', 'callCritic', ...SHARED],
  critic: ['readCV', 'readPreferences', 'readJob', 'loadSkill', ...SHARED],
};

export function toolsFor(agent: AgentName): ToolDef<any>[] {
  return AGENT_TOOLS[agent].map((name) => ALL_TOOLS[name]);
}

export function toOllamaTool(tool: ToolDef<any>): Tool {
  const { $schema: _s, ...parameters } = z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }) as any;
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters } };
}

/**
 * Models sometimes send JSON-encoded strings for object/array parameters, or the whole
 * argument object as a string. Decode those before validation.
 */
export function coerceArgs(raw: unknown, tool: ToolDef<any>): unknown {
  let args = raw;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args || '{}');
    } catch {
      return args;
    }
  }
  if (args === null || args === undefined) return {};
  if (typeof args !== 'object') return args;
  const props = (toOllamaTool(tool).function.parameters?.properties ?? {}) as Record<string, { type?: string | string[] }>;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    const type = props[key]?.type;
    const wantsStructured = type === 'object' || type === 'array';
    if (typeof value === 'string' && wantsStructured && /^\s*[[{]/.test(value)) {
      try {
        out[key] = JSON.parse(value);
      } catch {
        // leave as-is; validation will report it
      }
    }
    if (value === null) delete out[key];
  }
  return out;
}

export interface ToolOutcome {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
}

export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (!AGENT_TOOLS[ctx.agent].includes(name)) {
    return { ok: false, content: `Error: tool "${name}" is not available to the ${ctx.agent}. Available: ${AGENT_TOOLS[ctx.agent].join(', ')}` };
  }
  const tool = ALL_TOOLS[name];
  const parsed = tool.schema.safeParse(coerceArgs(rawArgs, tool));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, content: `Error: invalid arguments for ${name}: ${issues}` };
  }
  try {
    const result = await tool.run(parsed.data, ctx);
    return { ok: true, content: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };
  } catch (err: any) {
    if (ctx.signal?.aborted) throw err;
    return { ok: false, content: `Error: ${err?.message ?? String(err)}` };
  }
}
