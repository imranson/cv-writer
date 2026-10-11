export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  /** For role "tool": the name of the tool whose result this is. */
  toolName?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatDelta {
  content?: string;
  thinking?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
  onDelta?: (delta: ChatDelta) => void;
}

export interface ChatResult {
  message: ChatMessage;
  usage: Usage;
  doneReason?: string;
}

/** Minimal chat-model contract the agents depend on; implemented by Ollama and by test doubles. */
export interface ChatModel {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResult>;
  /** Context window of the model in tokens. */
  contextLength(): Promise<number>;
}

export class AbortError extends Error {
  constructor(message = 'The operation was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
