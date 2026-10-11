import type { AgentName, ThinkSetting } from '../config.js';

export interface ToolCall {
  function: {
    name: string;
    /** Ollama returns an object; some models send a JSON string instead. */
    arguments: Record<string, unknown> | string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  /** Which agent is calling; real backends ignore it, test doubles use it to script replies. */
  agent: AgentName;
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  think?: ThinkSetting;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  message: ChatMessage;
  usage?: Usage;
}

export interface Delta {
  content?: string;
  thinking?: string;
}

export interface LLM {
  chat(request: ChatRequest, onDelta?: (delta: Delta) => void): Promise<ChatResult>;
  /** Context window in tokens, if the backend can tell. */
  contextWindow(model: string): Promise<number | undefined>;
}

export class AbortError extends Error {
  constructor(message = 'Stopped by user') {
    super(message);
    this.name = 'AbortError';
  }
}
