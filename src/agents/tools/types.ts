import { z } from 'zod';
import type { Repo } from '../../db/repo.js';
import type { WebOptions } from '../../lib/web.js';
import type { ToolSpec } from '../../llm/types.js';
import type { AgentType, EmitFn } from '../../shared/events.js';
import type { SkillRegistry } from '../skills.js';

export interface ToolContext {
  userId: string;
  agent: AgentType;
  runId: string;
  callId: string;
  repo: Repo;
  skills: SkillRegistry;
  web: WebOptions;
  emit: EmitFn;
  signal: AbortSignal;
  /** Job the run is focused on (selected in the UI, or passed to a subagent). */
  focusJobId?: string | null;
  /** Starts a subagent run and resolves with its final report. */
  callAgent: (agent: 'writer' | 'critic', task: string, opts: { jobId: string; callId: string }) => Promise<string>;
  /** Renders the CV to PDF and returns its page count (null when rendering is unavailable). */
  pageCount?: (jobId: string) => Promise<number | null>;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Error whose message is meant for the model (bad arguments, missing data…). */
export class ToolError extends Error {}

function cleanSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema' || k === 'propertyNames') continue;
      out[k] = cleanSchema(v);
    }
    return out;
  }
  return node;
}

const specCache = new WeakMap<ToolDef, ToolSpec>();

export function toToolSpec(def: ToolDef): ToolSpec {
  let spec = specCache.get(def);
  if (!spec) {
    spec = {
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: cleanSchema(z.toJSONSchema(def.schema)) as Record<string, unknown>,
      },
    };
    specCache.set(def, spec);
  }
  return spec;
}

/**
 * Models sometimes send arguments as a JSON string, or nest objects as strings. Normalise to an
 * object and parse stringified values where the schema expects an object/array/any.
 */
export function normalizeArgs(def: ToolDef, raw: unknown): Record<string, unknown> {
  let args: unknown = raw;
  if (typeof args === 'string') {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch {
      throw new ToolError(`Arguments for ${def.name} must be a JSON object`);
    }
  }
  if (args === null || args === undefined) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolError(`Arguments for ${def.name} must be a JSON object`);
  const props = ((toToolSpec(def).function.parameters as any).properties ?? {}) as Record<string, any>;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    const type = props[key]?.type;
    if (typeof value === 'string' && type !== 'string' && /^\s*[[{]/.test(value)) {
      try {
        out[key] = JSON.parse(value);
      } catch {
        /* leave as-is; validation will report */
      }
    }
    // Models often fill unused optional params with null / "" — treat those as absent.
    if (value === null && type && type !== 'null') delete out[key];
    if (value === '' && type === 'string') delete out[key];
  }
  return out;
}

export async function executeTool(def: ToolDef, rawArgs: unknown, ctx: ToolContext): Promise<unknown> {
  const args = normalizeArgs(def, rawArgs);
  const parsed = def.schema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ToolError(`Invalid arguments for ${def.name}: ${issues}`);
  }
  return def.run(parsed.data, ctx);
}

/** Serialises a tool result for the model, capping its size to protect the context window. */
export function serializeResult(result: unknown, maxChars = 30_000): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
  if (text === undefined) return 'null';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} characters]`;
}
