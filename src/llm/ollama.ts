import { Ollama, type Message as OllamaMessage, type Tool as OllamaTool } from 'ollama';
import type { ThinkSetting } from '../config.ts';
import {
  AbortError,
  type ChatMessage,
  type ChatModel,
  type ChatRequest,
  type ChatResult,
  type ToolCall,
  type ToolSchema,
} from './types.ts';

export interface OllamaChatModelOptions {
  host: string;
  model: string;
  apiKey?: string;
  think?: ThinkSetting;
  temperature?: number;
  /** Fixed context length; when omitted it is read from the model via /api/show. */
  contextLength?: number;
  /** Used when the model does not report a context length. */
  fallbackContextLength?: number;
  fetch?: typeof fetch;
}

export function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  return messages.map((m) => {
    const out: OllamaMessage = { role: m.role, content: m.content };
    if (m.thinking) out.thinking = m.thinking;
    if (m.toolCalls?.length) out.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
    if (m.toolName) out.tool_name = m.toolName;
    return out;
  });
}

export function toOllamaTools(tools: ToolSchema[]): OllamaTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters as OllamaTool['function']['parameters'] },
  }));
}

/** Some models return tool arguments as a JSON string rather than an object. */
export function normaliseArguments(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

export class OllamaChatModel implements ChatModel {
  readonly name: string;
  private readonly client: Ollama;
  private cachedContextLength: number | undefined;

  constructor(private readonly opts: OllamaChatModelOptions) {
    this.name = opts.model;
    this.cachedContextLength = opts.contextLength;
    this.client = new Ollama({
      host: opts.host,
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : undefined,
      fetch: opts.fetch,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const { signal } = request;
    if (signal?.aborted) throw new AbortError();

    const stream = await this.client.chat({
      model: this.opts.model,
      messages: toOllamaMessages(request.messages),
      tools: request.tools?.length ? toOllamaTools(request.tools) : undefined,
      think: this.opts.think,
      options: this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : undefined,
      stream: true,
    });

    const onAbort = () => stream.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let content = '';
    let thinking = '';
    const toolCalls: ToolCall[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let doneReason: string | undefined;

    try {
      for await (const part of stream) {
        const msg = part.message;
        if (msg?.thinking) {
          thinking += msg.thinking;
          request.onDelta?.({ thinking: msg.thinking });
        }
        if (msg?.content) {
          content += msg.content;
          request.onDelta?.({ content: msg.content });
        }
        for (const call of msg?.tool_calls ?? []) {
          toolCalls.push({ name: call.function.name, arguments: normaliseArguments(call.function.arguments) });
        }
        if (part.done) {
          promptTokens = part.prompt_eval_count ?? 0;
          completionTokens = part.eval_count ?? 0;
          doneReason = part.done_reason;
        }
      }
    } catch (err) {
      if (signal?.aborted) throw new AbortError();
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) throw new AbortError();

    const message: ChatMessage = { role: 'assistant', content };
    if (thinking) message.thinking = thinking;
    if (toolCalls.length) message.toolCalls = toolCalls;
    return { message, usage: { promptTokens, completionTokens }, doneReason };
  }

  async contextLength(): Promise<number> {
    if (this.cachedContextLength) return this.cachedContextLength;
    try {
      const info = await this.client.show({ model: this.opts.model });
      // Typed as a Map by ollama-js but delivered as a plain JSON object.
      const raw = (info as unknown as { model_info?: Record<string, unknown> | Map<string, unknown> }).model_info ?? {};
      const modelInfo: Record<string, unknown> = raw instanceof Map ? Object.fromEntries(raw) : raw;
      const key = Object.keys(modelInfo).find((k) => k.endsWith('.context_length'));
      const value = key ? Number(modelInfo[key]) : NaN;
      if (Number.isFinite(value) && value > 0) {
        this.cachedContextLength = value;
        return value;
      }
    } catch {
      /* model metadata unavailable — fall back */
    }
    return this.opts.fallbackContextLength ?? 131_072;
  }
}
