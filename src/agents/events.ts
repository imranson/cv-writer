import type { AgentName } from '../config.js';
import type { Usage } from '../llm/types.js';

export type DataEntity = 'profile' | 'job' | 'cv' | 'css' | 'preferences';

export type AgentEvent =
  | { type: 'run_start'; runId: string; parentRunId?: string; agent: AgentName; model: string; task: string; at: string }
  | { type: 'llm_start'; runId: string; step: number; at: string }
  | { type: 'text_delta'; runId: string; delta: string }
  | { type: 'thinking_delta'; runId: string; delta: string }
  | {
      type: 'llm_end';
      runId: string;
      step: number;
      content: string;
      thinking?: string;
      toolCalls: { id: string; name: string }[];
      usage?: Usage;
      durationMs: number;
      at: string;
    }
  | { type: 'tool_start'; runId: string; callId: string; name: string; args: unknown; at: string }
  | { type: 'tool_end'; runId: string; callId: string; name: string; ok: boolean; result: string; durationMs: number; at: string }
  | {
      type: 'context';
      runId: string;
      agent: AgentName;
      usedTokens: number;
      contextWindow: number;
      estimated: boolean;
      at: string;
    }
  | {
      type: 'run_end';
      runId: string;
      agent: AgentName;
      ok: boolean;
      result: string;
      steps: number;
      usage: Usage;
      durationMs: number;
      at: string;
    }
  | { type: 'data_changed'; entity: DataEntity; jobId?: string; at: string }
  | { type: 'user_message'; content: string; at: string }
  | { type: 'error'; runId?: string; message: string; at: string }
  | { type: 'done'; at: string };

export type Emit = (event: AgentEvent) => void;

/** Streaming deltas are shown live but not persisted (the aggregated text is in llm_end). */
export function isPersistable(event: AgentEvent): boolean {
  return event.type !== 'text_delta' && event.type !== 'thinking_delta' && event.type !== 'llm_start';
}

export const now = () => new Date().toISOString();
