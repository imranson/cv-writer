import type { Usage } from '../shared/events.js';

export interface ToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> | string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  think?: boolean;
  signal?: AbortSignal;
  onThinking?: (delta: string) => void;
  onText?: (delta: string) => void;
}

export interface ChatResponse {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage: Usage;
  doneReason?: string;
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Context window (tokens) for a model. */
  contextWindow(model: string): Promise<number>;
}
