import { z } from 'zod';
import type { AgentName } from '../config.js';
import type { Emit } from '../agents/events.js';
import type { ToolCall, ToolSchema } from '../llm/types.js';

export interface ToolContext {
  agent: AgentName;
  depth: number;
  emit: Emit;
  signal?: AbortSignal;
}

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<S extends z.ZodObject>(tool: Tool<S>): Tool {
  return tool as unknown as Tool;
}

/**
 * Accepts either a value or a JSON string of it. Models sometimes serialise
 * nested objects/arrays as strings inside tool arguments.
 */
export function jsonish<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, schema);
}

export const MAX_TOOL_OUTPUT = 24_000;

export function toToolSchema(tool: Tool): ToolSchema {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(tool.schema, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters } };
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
}

export function stringifyResult(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  if (text === undefined) return 'OK';
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated ${text.length - MAX_TOOL_OUTPUT} characters]`;
}

export interface ToolOutcome {
  name: string;
  ok: boolean;
  args: unknown;
  output: string;
}

/** Runs a model-requested tool call. Never throws: errors become text the model can react to. */
export async function executeToolCall(tools: Tool[], call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const name = call.function?.name ?? '';
  let args: unknown = call.function?.arguments ?? {};
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return { name, ok: false, args, output: `Error: unknown tool "${name}". Available tools: ${tools.map((t) => t.name).join(', ')}` };
  }
  if (typeof args === 'string') {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch {
      return { name, ok: false, args, output: 'Error: tool arguments were not valid JSON' };
    }
  }
  // Models often send `null` for optional parameters they mean to omit.
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    args = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null));
  }
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return { name, ok: false, args, output: `Error: invalid arguments for ${name}: ${formatZodError(parsed.error)}` };
  }
  try {
    const result = await tool.run(parsed.data, ctx);
    return { name, ok: true, args: parsed.data, output: stringifyResult(result) };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return { name, ok: false, args: parsed.data, output: `Error: ${(err as Error).message}` };
  }
}
