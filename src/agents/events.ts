import type { AgentName } from '../config.js';

export type DataKind = 'profile' | 'job' | 'cv';

/** Everything the UI can observe while agents work. `depth` 0 is the coordinator. */
export type AgentEvent =
  | { type: 'agent_start'; agent: AgentName; depth: number; task: string }
  | { type: 'agent_end'; agent: AgentName; depth: number; ok: boolean }
  | { type: 'delta'; agent: AgentName; depth: number; content?: string; thinking?: string }
  | { type: 'message'; agent: AgentName; depth: number; content: string }
  | { type: 'tool_call'; agent: AgentName; depth: number; name: string; args: unknown }
  | { type: 'tool_result'; agent: AgentName; depth: number; name: string; ok: boolean; preview: string }
  | { type: 'context'; agent: AgentName; depth: number; usedTokens: number; contextWindow: number }
  | { type: 'data_changed'; kind: DataKind; id: string };

export type Emit = (event: AgentEvent) => void;
