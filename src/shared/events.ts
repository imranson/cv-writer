/** Event protocol streamed from the server to the UI (SSE) while agents work. Browser-safe. */

export type AgentType = 'coordinator' | 'writer' | 'critic';

export interface ContextInfo {
  /** Estimated tokens in the request about to be / just sent (chars ÷ 4 heuristic). */
  estimatedTokens: number;
  /** Model context window in tokens. */
  window: number;
  /** estimatedTokens / window × 100, one decimal. */
  percent: number;
  /** Prompt tokens reported by the model for the last completed call, when available. */
  promptTokens?: number;
}

export interface Usage {
  promptTokens?: number;
  evalTokens?: number;
  durationMs?: number;
}

export type DataEntity = 'profile' | 'job' | 'jobs' | 'cv' | 'css' | 'preferences';

export type AgentEvent =
  | { type: 'turn_start'; turnId: string; at: string }
  | {
      type: 'agent_start';
      runId: string;
      agent: AgentType;
      model: string;
      parentRunId?: string;
      parentCallId?: string;
      depth: number;
      task: string;
      systemPrompt: string;
      tools: string[];
      at: string;
    }
  | { type: 'llm_start'; runId: string; step: number; context: ContextInfo; at: string }
  | { type: 'thinking'; runId: string; delta: string }
  | { type: 'text'; runId: string; delta: string }
  | { type: 'llm_end'; runId: string; step: number; usage: Usage; context: ContextInfo; at: string }
  | { type: 'tool_call'; runId: string; callId: string; name: string; args: unknown; at: string }
  | { type: 'tool_result'; runId: string; callId: string; name: string; ok: boolean; result: string; ms: number }
  | { type: 'skill_loaded'; runId: string; skill: string }
  | { type: 'data_changed'; entity: DataEntity; jobId?: string }
  | {
      type: 'agent_end';
      runId: string;
      status: 'done' | 'error' | 'aborted';
      output: string;
      error?: string;
      at: string;
    }
  | { type: 'chat_title'; title: string }
  | { type: 'turn_end'; turnId: string; status: 'done' | 'error' | 'aborted'; answer: string; at: string }
  | { type: 'error'; message: string };

export type EmitFn = (event: AgentEvent) => void;
