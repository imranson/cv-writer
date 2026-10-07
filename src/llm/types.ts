import type { ChatMessage } from '../domain/schemas.js';

export type Think = boolean | 'low' | 'medium' | 'high';

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  think?: Think;
}

export interface ChatDelta {
  content?: string;
  thinking?: string;
  /** The stream failed and is being retried: discard what was streamed so far. */
  reset?: boolean;
}

export interface ChatResult {
  message: ChatMessage;
  usage: { promptTokens: number; outputTokens: number };
}

/** The one thing agents need from a model provider. Tests substitute scripted models. */
export interface ChatModel {
  chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult>;
}
