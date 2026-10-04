import { z } from 'zod';

export const ToolCallSchema = z.object({
  id: z.string().optional(),
  function: z.object({
    index: z.number().optional(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  thinking: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  /** On tool messages: which tool (and which call) this result answers. */
  tool_name: z.string().optional(),
  tool_call_id: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const UsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const emptyUsage = (): Usage => ({ requests: 0, promptTokens: 0, outputTokens: 0 });

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Ollama's `think` option: on/off, or a level for models that support one (e.g. gpt-oss). */
export type Think = boolean | 'low' | 'medium' | 'high';

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  think?: Think;
}

export interface ChatResult {
  message: ChatMessage;
  promptTokens: number;
  outputTokens: number;
  doneReason?: string;
}

/** The one call the agents need from a model provider; faked in tests. */
export interface ChatClient {
  chat(request: ChatRequest): Promise<ChatResult>;
}
