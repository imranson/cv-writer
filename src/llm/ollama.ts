import { Ollama } from 'ollama';
import type { ChatMessage } from '../domain/schemas.js';
import { stripThinking } from '../util/text.js';
import type { ChatDelta, ChatModel, ChatRequest, ChatResult } from './types.js';

export const OLLAMA_LOCAL_HOST = 'http://127.0.0.1:11434';
export const OLLAMA_CLOUD_HOST = 'https://ollama.com';

export interface OllamaChatOptions {
  host: string;
  /** Needed only when calling https://ollama.com directly. */
  apiKey?: string;
  /** Longest a whole request may take (reasoning models can think for minutes). */
  timeoutMs?: number;
  /** Longest a streamed response may go without sending anything. */
  idleTimeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

/** Cloud models are called "name:cloud" through a local daemon, and plain "name" on ollama.com. */
export function modelNameFor(host: string, model: string): string {
  return /^https?:\/\/(www\.)?ollama\.com/i.test(host) ? model.replace(/[-:]cloud$/i, '') : model;
}

export function isRetryable(err: unknown): boolean {
  const e = err as { status_code?: number; name?: string; message?: string; cause?: { code?: string } };
  if (typeof e?.status_code === 'number') return e.status_code === 429 || e.status_code >= 500;
  if (e?.name === 'TimeoutError') return true;
  const msg = `${e?.message ?? ''} ${e?.cause?.code ?? ''}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|terminated/i.test(msg);
}

export function describeError(err: unknown, host: string): string {
  const e = err as { status_code?: number; message?: string };
  if (e?.status_code === 401 || e?.status_code === 403)
    return `Ollama refused the request (${e.status_code}). Run \`ollama signin\` for cloud models, or set OLLAMA_API_KEY.`;
  if (e?.status_code === 404) return `Ollama could not find the model: ${e.message}. Check the model name.`;
  if (/ECONNREFUSED|fetch failed/i.test(`${e?.message} ${(err as { cause?: { code?: string } })?.cause?.code ?? ''}`))
    return `Could not reach Ollama at ${host}. Is it running (\`ollama serve\`)?`;
  return `Ollama error: ${e?.message ?? String(err)}`;
}

type RawToolCall = { function: { name: string; arguments: unknown } };

function parseArguments(args: unknown): Record<string, unknown> {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { __unparseable: args };
    }
  }
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

export function normaliseMessage(raw: { content?: string; thinking?: string; tool_calls?: RawToolCall[] }): ChatMessage {
  const message: ChatMessage = { role: 'assistant', content: stripThinking(raw.content ?? '') };
  if (raw.thinking) message.thinking = raw.thinking;
  if (raw.tool_calls?.length)
    message.tool_calls = raw.tool_calls.map((c) => ({ function: { name: c.function.name, arguments: parseArguments(c.function.arguments) } }));
  return message;
}

export class OllamaChatModel implements ChatModel {
  private timeoutMs: number;
  private idleTimeoutMs: number;
  private retries: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private options: OllamaChatOptions) {
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 3 * 60_000;
    this.retries = options.retries ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** A client per request, so each request has its own deadline and can be aborted on its own. */
  private client(signal: AbortSignal): Ollama {
    const baseFetch = this.options.fetch ?? fetch;
    return new Ollama({
      host: this.options.host,
      ...(this.options.apiKey ? { headers: { Authorization: `Bearer ${this.options.apiKey}` } } : {}),
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        baseFetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })) as typeof fetch,
    });
  }

  async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult> {
    let attempt = 0;
    for (;;) {
      try {
        return onDelta ? await this.streamOnce(request, onDelta) : await this.once(request);
      } catch (err) {
        if (attempt >= this.retries || !isRetryable(err)) throw new Error(describeError(err, this.options.host), { cause: err });
        onDelta?.({ reset: true });
        await this.sleep(1000 * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  private body(request: ChatRequest) {
    return {
      model: modelNameFor(this.options.host, request.model),
      messages: request.messages,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(request.think !== undefined ? { think: request.think } : {}),
    };
  }

  private async once(request: ChatRequest): Promise<ChatResult> {
    const res = await this.client(AbortSignal.timeout(this.timeoutMs)).chat({ ...this.body(request), stream: false });
    return {
      message: normaliseMessage(res.message as Parameters<typeof normaliseMessage>[0]),
      usage: { promptTokens: res.prompt_eval_count ?? 0, outputTokens: res.eval_count ?? 0 },
    };
  }

  private async streamOnce(request: ChatRequest, onDelta: (delta: ChatDelta) => void): Promise<ChatResult> {
    const idle = new AbortController();
    let idleTimer: NodeJS.Timeout | undefined;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(Object.assign(new Error('Ollama stopped responding'), { name: 'TimeoutError' })), this.idleTimeoutMs);
    };
    touch();
    try {
      const stream = await this.client(AbortSignal.any([idle.signal, AbortSignal.timeout(this.timeoutMs)])).chat({ ...this.body(request), stream: true });
      let content = '';
      let thinking = '';
      const toolCalls: RawToolCall[] = [];
      let usage = { promptTokens: 0, outputTokens: 0 };
      for await (const part of stream) {
        touch();
        const m = part.message;
        if (m?.thinking) {
          thinking += m.thinking;
          onDelta({ thinking: m.thinking });
        }
        if (m?.content) {
          content += m.content;
          onDelta({ content: m.content });
        }
        if (m?.tool_calls?.length) toolCalls.push(...(m.tool_calls as RawToolCall[]));
        if (part.done) usage = { promptTokens: part.prompt_eval_count ?? 0, outputTokens: part.eval_count ?? 0 };
      }
      return { message: normaliseMessage({ content, thinking, tool_calls: toolCalls }), usage };
    } catch (err) {
      throw idle.signal.aborted ? idle.signal.reason : err;
    } finally {
      clearTimeout(idleTimer);
    }
  }
}
