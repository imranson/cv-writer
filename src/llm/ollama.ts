import { Ollama, type Message, type ToolCall } from 'ollama';
import type { Config } from '../config';
import { htmlToText } from '../util/text';
import type { ChatRequest, ChatResult, LLM, WebClient, WebPage, WebSearchResult } from './types';

const DEFAULT_CONTEXT_WINDOW = 32_768;

export function createOllamaClient(config: Pick<Config, 'ollamaHost' | 'ollamaApiKey'>): Ollama {
  return new Ollama({
    host: config.ollamaHost,
    headers: config.ollamaApiKey ? { Authorization: `Bearer ${config.ollamaApiKey}` } : undefined,
  });
}

export class OllamaLLM implements LLM {
  private windows = new Map<string, Promise<number>>();

  constructor(
    private client: Ollama,
    private contextWindowOverride?: number,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const stream = await this.client.chat({
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      think: req.think,
      stream: true,
    });
    const onAbort = () => stream.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });

    let content = '';
    let thinking = '';
    const toolCalls: ToolCall[] = [];
    let promptTokens = 0;
    let outputTokens = 0;
    try {
      for await (const chunk of stream) {
        const m = chunk.message;
        if (m?.thinking) {
          thinking += m.thinking;
          req.onDelta?.({ thinking: m.thinking });
        }
        if (m?.content) {
          content += m.content;
          req.onDelta?.({ content: m.content });
        }
        if (m?.tool_calls?.length) toolCalls.push(...m.tool_calls);
        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count ?? 0;
          outputTokens = chunk.eval_count ?? 0;
        }
      }
    } catch (err: any) {
      if (req.signal?.aborted) throw new Error('Aborted');
      throw err;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }

    const message: Message = { role: 'assistant', content };
    if (thinking) message.thinking = thinking;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { message, promptTokens, outputTokens };
  }

  contextWindow(model: string): Promise<number> {
    if (this.contextWindowOverride) return Promise.resolve(this.contextWindowOverride);
    let cached = this.windows.get(model);
    if (!cached) {
      cached = this.client
        .show({ model })
        .then((info) => contextLengthFromModelInfo(info.model_info) ?? DEFAULT_CONTEXT_WINDOW)
        .catch(() => DEFAULT_CONTEXT_WINDOW);
      this.windows.set(model, cached);
    }
    return cached;
  }
}

/** `/api/show` reports the window as `<architecture>.context_length`. */
export function contextLengthFromModelInfo(info: unknown): number | undefined {
  if (!info) return undefined;
  const entries = info instanceof Map ? [...info.entries()] : Object.entries(info as object);
  for (const [key, value] of entries) {
    if (String(key).endsWith('.context_length') && Number(value) > 0) return Number(value);
  }
  return undefined;
}

export class OllamaWeb implements WebClient {
  constructor(
    private client: Ollama,
    private apiKey?: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: string, maxResults: number): Promise<WebSearchResult[]> {
    if (!this.apiKey) throw new Error('Web search needs OLLAMA_API_KEY to be set');
    // The REST API expects snake_case `max_results`; ollama-js forwards the body as-is.
    const res = await this.client.webSearch({ query, max_results: maxResults } as any);
    return (res.results ?? []).map((r: any) => ({ title: r.title ?? '', url: r.url ?? '', content: r.content ?? '' }));
  }

  async fetch(url: string): Promise<WebPage> {
    assertPublicHttpUrl(url);
    if (this.apiKey) {
      try {
        const res = await this.client.webFetch({ url });
        return { title: res.title ?? '', url: res.url ?? url, content: res.content ?? '', links: res.links ?? [] };
      } catch {
        // fall through to a direct fetch
      }
    }
    const res = await this.fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'cv-writer/0.6 (+https://ollama.com)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
    const html = await res.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
    const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]).slice(0, 50);
    return { title, url: res.url || url, content: htmlToText(html), links };
  }
}

/** Blocks non-http(s) schemes and obvious loopback / private-network hosts. */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs can be fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host);
  if (privateHost) throw new Error('Fetching local or private network addresses is not allowed');
  return url;
}
