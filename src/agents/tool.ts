import { z } from 'zod';
import type { ToolSchema } from '../llm/types.ts';
import type { Emit } from './events.ts';

export interface ToolContext {
  signal?: AbortSignal;
  emit: Emit;
}

export interface AgentTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<string>;
  /** When true, a successful call ends the agent loop (used for structured "submit" tools). */
  terminal?: boolean;
}

/** Type-preserving identity helper so tool args are inferred from the zod schema. */
export function defineTool<S extends z.ZodObject>(tool: AgentTool<S>): AgentTool {
  return tool as unknown as AgentTool;
}

export function toToolSchema(tool: AgentTool): ToolSchema {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  return { name: tool.name, description: tool.description, parameters };
}

/** Thrown by tools for user-facing failures; the message is returned to the model verbatim. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
}
