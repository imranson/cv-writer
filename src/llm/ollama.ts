import type { ChatRequest, ChatResponse, LlmClient, ToolCall } from './types.js';

export interface OllamaOptions {
  host: string;
  apiKey?: string;
  fallbackContextWindow: number;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * The local daemon exposes cloud models as `name:cloud` / `name-cloud`; ollama.com's API expects the
 * bare remote name. Strip the suffix when talking to ollama.com directly.
 */
export function resolveModelName(model: string, host: string): string {
  if (!/(^|\.)ollama\.com$/.test(safeHostname(host))) return model;
  return model.replace(/:cloud$/, '').replace(/-cloud$/, '');
}

function safeHostname(host: string): string {
  try {
    return new URL(host).hostname;
  } catch {
    return '';
  }
}

/** Parses an Ollama NDJSON stream, invoking `onLine` for each JSON object. */
export async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (obj: any) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onLine(JSON.parse(line));
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest) onLine(JSON.parse(rest));
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
}

export class OllamaClient implements LlmClient {
  private readonly f: typeof fetch;
  private readonly windows = new Map<string, number>();
  private readonly noThink = new Set<string>();

  constructor(private readonly opts: OllamaOptions) {
    this.f = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = resolveModelName(req.model, this.opts.host);
    const think = req.think !== false && !this.noThink.has(model);
    const body = {
      model,
      messages: req.messages,
      tools: req.tools?.length ? req.tools : undefined,
      stream: true,
      think: think || undefined,
    };
    let res: Response | undefined;
    const maxRetries = this.opts.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      res = await this.f(`${this.opts.host}/api/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (res.ok) break;
      const text = await res.text().catch(() => '');
      if (think && /think/i.test(text) && res.status === 400) {
        // Model doesn't support thinking — remember and retry without it.
        this.noThink.add(model);
        return this.chat({ ...req, think: false });
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`Ollama ${res.status}: ${extractError(text) || res.statusText}`);
      }
      await sleep((this.opts.retryDelayMs ?? 1000) * 2 ** attempt, req.signal);
    }
    if (!res.body) throw new Error('Ollama returned an empty body');

    const out: ChatResponse = { content: '', thinking: '', toolCalls: [], usage: {} };
    await readNdjson(res.body, (chunk) => {
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      const msg = chunk.message ?? {};
      if (msg.thinking) {
        out.thinking += msg.thinking;
        req.onThinking?.(msg.thinking);
      }
      if (msg.content) {
        out.content += msg.content;
        req.onText?.(msg.content);
      }
      if (Array.isArray(msg.tool_calls)) out.toolCalls.push(...(msg.tool_calls as ToolCall[]));
      if (chunk.done) {
        out.doneReason = chunk.done_reason;
        out.usage = {
          promptTokens: chunk.prompt_eval_count,
          evalTokens: chunk.eval_count,
          durationMs: chunk.total_duration ? Math.round(chunk.total_duration / 1e6) : undefined,
        };
      }
    });
    return out;
  }

  async contextWindow(model: string): Promise<number> {
    const name = resolveModelName(model, this.opts.host);
    const cached = this.windows.get(name);
    if (cached) return cached;
    let value = this.opts.fallbackContextWindow;
    try {
      const res = await this.f(`${this.opts.host}/api/show`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { model_info?: Record<string, unknown> };
        const key = Object.keys(json.model_info ?? {}).find((k) => k.endsWith('.context_length'));
        const n = key ? Number(json.model_info![key]) : NaN;
        if (Number.isFinite(n) && n > 0) value = n;
      }
    } catch {
      /* fall back */
    }
    this.windows.set(name, value);
    return value;
  }
}

function extractError(text: string): string {
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text.slice(0, 300);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    });
  });
}
