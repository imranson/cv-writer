import { Ollama, type Message } from 'ollama';
import type { ChatClient, ChatMessage, ChatRequest, ChatResult, ToolCall } from './types.js';

export const OLLAMA_CLOUD_HOST = 'https://ollama.com';
export const OLLAMA_LOCAL_HOST = 'http://127.0.0.1:11434';

/** Parses a host the way ollama-js does: "localhost:11434", ":11434" and full URLs all work. */
export function hostUrl(host: string): URL {
  if (host.startsWith(':')) return new URL(`http://127.0.0.1${host}`);
  return new URL(host.includes('://') ? host : `http://${host}`);
}

/** True when requests go straight to Ollama's cloud API rather than through a local daemon. */
export function isCloudHost(host: string): boolean {
  const { hostname } = hostUrl(host);
  return hostname === 'ollama.com' || hostname.endsWith('.ollama.com');
}

/**
 * A local daemon names cloud models "glm-5.3:cloud" or "gpt-oss:120b-cloud"; the cloud
 * API itself uses the bare name. Lets one model setting work against either host.
 */
export function cloudApiModelName(model: string): string {
  return model.replace(/:cloud$/, '').replace(/(:[^:]+)-cloud$/, '$1');
}

/** A model call failure, with a message written for the person running the app. */
export class LlmError extends Error {
  constructor(
    message: string,
    /** Retrying won't help (bad credentials, unknown model, nothing listening). */
    readonly fatal: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function describeFailure(err: unknown, model: string, host: string): LlmError {
  const status = (err as { status_code?: number }).status_code;
  const detail = (err as Error).message ?? String(err);
  const cloud = isCloudHost(host);
  if (status === 401 || status === 403) {
    return new LlmError(
      cloud
        ? `Ollama cloud rejected the API key (${status}). Check OLLAMA_API_KEY (create one at https://ollama.com/settings/keys).`
        : `Ollama needs you to sign in to use cloud models (${status}). Run \`ollama signin\`, or set OLLAMA_API_KEY to call the cloud directly.`,
      true,
      status,
    );
  }
  if (status === 404) {
    return new LlmError(
      `Model "${model}" was not found on ${host} (${detail}). ` +
        (cloud ? 'Check the name against https://ollama.com/search?c=cloud.' : `Try \`ollama pull ${model}\`.`),
      true,
      status,
    );
  }
  const code = (err as { cause?: { code?: string } }).cause?.code;
  if (status === undefined && (code === 'ECONNREFUSED' || code === 'ENOTFOUND')) {
    return new LlmError(
      `Can't reach Ollama at ${host} (${code}). Start the Ollama app or \`ollama serve\`, or set OLLAMA_API_KEY to use ${OLLAMA_CLOUD_HOST} directly.`,
      true,
    );
  }
  if ((err as Error).name === 'TimeoutError') return new LlmError(`Ollama did not answer in time (${detail}).`, false);
  return new LlmError(`Ollama request failed${status ? ` (${status})` : ''}: ${detail}`, false, status);
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status_code?: number }).status_code;
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  const code = (err as { cause?: { code?: string } }).cause?.code;
  return code !== 'ECONNREFUSED' && code !== 'ENOTFOUND';
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function fromOllama(message: Message): ChatMessage {
  // The server also sends call ids and indexes, which ollama-js's types leave out.
  const raw = message as unknown as { tool_calls?: Array<{ id?: string; function: { index?: number; name: string; arguments: unknown } }> };
  const toolCalls: ToolCall[] = (raw.tool_calls ?? []).map((call) => ({
    ...(call.id ? { id: call.id } : {}),
    function: {
      ...(call.function.index !== undefined ? { index: call.function.index } : {}),
      name: call.function.name,
      arguments: parseArguments(call.function.arguments),
    },
  }));
  return {
    role: 'assistant',
    content: message.content ?? '',
    ...(message.thinking ? { thinking: message.thinking } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

export interface OllamaClientOptions {
  host: string;
  /** Bearer token for https://ollama.com; not needed through a signed-in local daemon. */
  apiKey?: string;
  fetch?: typeof fetch;
  /** Per-request timeout. Long CV drafts from large models can take a few minutes. */
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class OllamaChatClient implements ChatClient {
  private readonly ollama: Ollama;
  private readonly direct: boolean;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: OllamaClientOptions) {
    const baseFetch = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? 300_000;
    this.direct = isCloudHost(options.host);
    this.retries = options.retries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.ollama = new Ollama({
      host: options.host,
      fetch: ((input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        return baseFetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
      }) as typeof fetch,
      ...(options.apiKey ? { headers: { Authorization: `Bearer ${options.apiKey}` } } : {}),
    });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const model = this.direct ? cloudApiModelName(request.model) : request.model;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.ollama.chat({
          model,
          // tool_call_id is accepted by the server but missing from ollama-js's Message type.
          messages: request.messages as Message[],
          ...(request.tools?.length ? { tools: request.tools } : {}),
          ...(request.think !== undefined ? { think: request.think } : {}),
          stream: false,
        });
        return {
          message: fromOllama(response.message),
          promptTokens: response.prompt_eval_count ?? 0,
          outputTokens: response.eval_count ?? 0,
          ...(response.done_reason ? { doneReason: response.done_reason } : {}),
        };
      } catch (err) {
        if (attempt >= this.retries || !isRetryable(err)) throw describeFailure(err, request.model, this.options.host);
        await this.sleep(this.retryDelayMs * 2 ** attempt);
      }
    }
  }
}
