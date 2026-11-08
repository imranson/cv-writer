export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: Role;
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  /** For role "tool": the tool that produced this result. */
  tool_name?: string;
  tool_call_id?: string;
  /** UI metadata (ISO timestamp). Never sent to the model. */
  at?: string;
}

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  message: ChatMessage;
  usage?: Usage;
  doneReason?: string;
  durationMs: number;
}

export interface StreamHandlers {
  onContent?(delta: string): void;
  onThinking?(delta: string): void;
}

export interface LlmClient {
  chat(req: ChatRequest, handlers?: StreamHandlers): Promise<ChatResult>;
  /** Context length reported by the model, if the provider can tell. */
  contextWindow?(model: string): Promise<number | undefined>;
}
