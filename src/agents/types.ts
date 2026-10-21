import type { z } from 'zod';
import type { AgentName, ThinkSetting } from '../config';
import type { LLM, WebClient } from '../llm/types';
import type { SkillLibrary } from '../skills';
import type { ActivityEvent, Store } from '../store';

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** Everything streamed to the browser: persisted activity events plus transient text deltas. */
export type StreamEvent =
  | ActivityEvent
  | { type: 'delta'; at: string; runId: string; agent: AgentName; content?: string; thinking?: string };

export type EmitInput = DistributiveOmit<StreamEvent, 'at'>;

export interface AgentDeps {
  store: Store;
  llm: LLM;
  web: WebClient;
  skills: SkillLibrary;
  models: Record<AgentName, string>;
  think?: ThinkSetting;
  now?: () => Date;
  timeZone?: string;
}

export interface ToolContext {
  deps: AgentDeps;
  userId: string;
  agent: AgentName;
  runId: string;
  emit: (event: EmitInput) => void;
  signal?: AbortSignal;
  /** Job currently open in the user's UI, if any. */
  activeJobId?: string;
  /** Runs a subagent with a task brief and resolves with its final report. */
  spawn(agent: AgentName, task: string): Promise<string>;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: ToolDef<S>): ToolDef<S> {
  return tool;
}
