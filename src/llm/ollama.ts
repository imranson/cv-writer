import type { ChatMessage, ChatRequest, ChatResult, LlmClient, StreamHandlers, ToolCall } from './types.js';
import { isOllamaCloud } from '../lib/web.js';

export interface OllamaOptions {
  host: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Retries for 429/5xx responses received before streaming starts. */
  retries?: number;
  retryDelayMs?: number;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Local daemons address cloud models as "name:cloud"/"name-cloud"; ollama.com uses the bare name. */
export function normalizeModel(model: string, host: string): string {
  if (!isOllamaCloud(host)) return model;
  return model.replace(/:cloud$/, '').replace(/-cloud$/, '');
}

interface OllamaChunk {
  message?: { role?: string; content?: string; thinking?: string; tool_calls?: { id?: string; function: { name: string; arguments: unknown } }[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: m.role, content: m.content ?? '' };
  if (m.thinking) wire.thinking = m.thinking;
  if (m.tool_calls?.length) wire.tool_calls = m.tool_calls.map((c) => ({ ...(c.id ? { id: c.id } : {}), function: c.function }));
  if (m.tool_name) wire.tool_name = m.tool_name;
  if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
  return wire;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
    } catch {
      return { _raw: raw };
    }
  }
  return {};
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

export function createOllamaClient(opts: OllamaOptions): LlmClient {
  const host = opts.host.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 2;
  const retryDelay = opts.retryDelayMs ?? 1500;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const windows = new Map<string, Promise<number | undefined>>();

  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(`${host}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = JSON.parse(text).error ?? text;
      } catch {
        /* plain text error */
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(retryDelay * (attempt + 1), signal);
        continue;
      }
      const hint = res.status === 401 ? ' (check OLLAMA_API_KEY or run `ollama signin`)' : '';
      throw new OllamaError(`Ollama ${path} failed with ${res.status}: ${message || res.statusText}${hint}`, res.status);
    }
  }

  return {
    async chat(req: ChatRequest, handlers: StreamHandlers = {}): Promise<ChatResult> {
      const started = Date.now();
      const res = await post(
        '/api/chat',
        {
          model: normalizeModel(req.model, host),
          messages: req.messages.map(toWireMessage),
          tools: req.tools?.length ? req.tools : undefined,
          stream: true,
        },
        req.signal,
      );
      if (!res.body) throw new OllamaError('Ollama returned an empty body');

      let content = '';
      let thinking = '';
      const toolCalls: ToolCall[] = [];
      let final: OllamaChunk | undefined;

      const handle = (line: string) => {
        if (!line.trim()) return;
        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line);
        } catch {
          throw new OllamaError(`Malformed stream line from Ollama: ${line.slice(0, 120)}`);
        }
        if (chunk.error) throw new OllamaError(`Ollama error: ${chunk.error}`);
        const m = chunk.message;
        if (m?.content) {
          content += m.content;
          handlers.onContent?.(m.content);
        }
        if (m?.thinking) {
          thinking += m.thinking;
          handlers.onThinking?.(m.thinking);
        }
        for (const c of m?.tool_calls ?? []) {
          toolCalls.push({ id: c.id, function: { name: c.function.name, arguments: parseArguments(c.function.arguments) } });
        }
        if (chunk.done) final = chunk;
      };

      const decoder = new TextDecoder();
      let buffer = '';
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(part, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          handle(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      buffer += decoder.decode();
      handle(buffer);

      const message: ChatMessage = { role: 'assistant', content };
      if (thinking) message.thinking = thinking;
      if (toolCalls.length) message.tool_calls = toolCalls;
      return {
        message,
        usage:
          final && (final.prompt_eval_count !== undefined || final.eval_count !== undefined)
            ? { promptTokens: final.prompt_eval_count ?? 0, completionTokens: final.eval_count ?? 0 }
            : undefined,
        doneReason: final?.done_reason,
        durationMs: Date.now() - started,
      };
    },

    contextWindow(model: string) {
      const name = normalizeModel(model, host);
      if (!windows.has(name)) {
        windows.set(
          name,
          post('/api/show', { model: name }, AbortSignal.timeout(10_000))
            .then(async (res) => {
              const info = ((await res.json()) as { model_info?: Record<string, unknown> }).model_info ?? {};
              const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
              const n = key ? Number(info[key]) : NaN;
              return Number.isFinite(n) && n > 0 ? n : undefined;
            })
            .catch(() => {
              windows.delete(name); // retry detection next time
              return undefined;
            }),
        );
      }
      return windows.get(name)!;
    },
  };
}
