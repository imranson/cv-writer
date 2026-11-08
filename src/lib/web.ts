import { assertPublicUrl, type Resolver } from './netGuard.js';
import { htmlToText } from './html.js';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface FetchedPage {
  url: string;
  title: string;
  content: string;
  links?: string[];
  source: 'ollama' | 'direct';
}

export interface WebClient {
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
  fetch(url: string): Promise<FetchedPage>;
}

export interface WebClientOptions {
  /** Ollama host. ollama.com uses /api/web_*; a local daemon uses /api/experimental/web_*. */
  host: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  resolver?: Resolver;
  maxContentChars?: number;
  timeoutMs?: number;
}

const MAX_DIRECT_BYTES = 2_000_000;

export function isOllamaCloud(host: string): boolean {
  try {
    return new URL(host).hostname.endsWith('ollama.com');
  } catch {
    return false;
  }
}

export function createWebClient(opts: WebClientOptions): WebClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxChars = opts.maxContentChars ?? 12_000;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const base = opts.host.replace(/\/+$/, '');
  const prefix = isOllamaCloud(base) ? '/api' : '/api/experimental';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  const clip = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars)}\n…[truncated ${s.length - maxChars} chars]` : s);

  async function ollama<T>(endpoint: string, body: unknown): Promise<T> {
    const res = await doFetch(`${base}${prefix}/${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama ${endpoint} failed (${res.status}): ${text.slice(0, 300) || res.statusText}`);
    }
    return (await res.json()) as T;
  }

  async function direct(raw: string): Promise<FetchedPage> {
    let url = await assertPublicUrl(raw, opts.resolver);
    let res: Response | undefined;
    for (let hop = 0; hop < 5; hop++) {
      res = await doFetch(url, {
        redirect: 'manual',
        headers: { 'user-agent': 'cv-writer/0.7 (+web fetch tool)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        url = await assertPublicUrl(new URL(location, url).toString(), opts.resolver);
        continue;
      }
      break;
    }
    if (!res || !res.ok) throw new Error(`Fetch failed (${res?.status ?? 'no response'})`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_DIRECT_BYTES) throw new Error('Page is too large to fetch');
    const raw2 = (await res.text()).slice(0, MAX_DIRECT_BYTES);
    const type = res.headers.get('content-type') ?? '';
    const { title, text } = type.includes('html') || /<html|<body/i.test(raw2) ? htmlToText(raw2) : { title: '', text: raw2 };
    return { url: url.toString(), title, content: clip(text), source: 'direct' };
  }

  return {
    async search(query, maxResults = 5) {
      const max = Math.min(Math.max(Math.trunc(maxResults), 1), 10);
      const data = await ollama<{ results?: SearchResult[] }>('web_search', { query, max_results: max });
      return (data.results ?? []).slice(0, max).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        content: (r.content ?? '').slice(0, 1500),
      }));
    },

    async fetch(url) {
      // Validate up-front so the tool never asks anyone to fetch internal addresses.
      await assertPublicUrl(url, opts.resolver);
      try {
        const data = await ollama<{ title?: string; content?: string; links?: string[] | null }>('web_fetch', { url });
        return {
          url,
          title: data.title ?? '',
          content: clip(data.content ?? ''),
          links: (data.links ?? []).slice(0, 30),
          source: 'ollama',
        };
      } catch {
        return direct(url);
      }
    },
  };
}
