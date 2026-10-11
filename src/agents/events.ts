export type AgentName = 'coordinator' | 'writer' | 'critic';

export type ArtifactKind = 'profile' | 'job' | 'cv' | 'style' | 'critique' | 'skill' | 'session';

/** Events streamed to the UI while agents work. */
export type AgentEvent =
  | { type: 'text'; agent: AgentName; delta: string }
  | { type: 'thinking'; agent: AgentName; delta: string }
  | { type: 'tool_start'; agent: AgentName; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; agent: AgentName; callId: string; name: string; ok: boolean; preview: string }
  | { type: 'usage'; agent: AgentName; promptTokens: number; completionTokens: number }
  | { type: 'artifact'; kind: ArtifactKind; jobId?: string };

export type Emit = (event: AgentEvent) => void;

export const noopEmit: Emit = () => {};
