import { z } from 'zod';
import type { AgentName, Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { LlmClient, ToolSchema } from '../llm/types.js';
import type { WebClient } from '../lib/web.js';
import type { SkillLibrary } from '../skills/loader.js';
import type { Emit } from './events.js';

export interface PageCounter {
  countPages(html: string, css: string, preferences: Record<string, unknown>): Promise<number>;
}

/** Shared services available to every tool. */
export interface AgentServices {
  config: Config;
  repo: Repo;
  llm: LlmClient;
  web: WebClient;
  skills: SkillLibrary;
  pages?: PageCounter;
  now: () => Date;
  runSubagent(agent: 'writer' | 'critic', input: SubagentInput): Promise<SubagentResult>;
}

export interface SubagentInput {
  userId: string;
  jobId: string;
  task: string;
  parentRunId: string;
  emit: Emit;
  signal?: AbortSignal;
  timezone?: string;
}

export interface SubagentResult {
  ok: boolean;
  result: string;
  runId: string;
}

export interface ToolContext {
  userId: string;
  agent: AgentName;
  runId: string;
  /** The job a subagent was asked to work on; used when a tool call omits jobId. */
  boundJobId?: string;
  timezone?: string;
  emit: Emit;
  signal?: AbortSignal;
  services: AgentServices;
  /** Per-run counters (e.g. how many critiques a writer run requested). */
  counters: Map<string, number>;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

/** User-facing tool errors: reported back to the model instead of failing the run. */
export class ToolError extends Error {}

export function toToolSchema(tool: Tool): ToolSchema {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters } };
}

export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`).join('; ');
}
