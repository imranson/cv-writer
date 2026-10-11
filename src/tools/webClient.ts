import { Ollama } from 'ollama';
import { extractTitle, htmlToText } from '../lib/html.js';
import { assertPublicUrl, defaultLookup, type Lookup } from '../lib/netGuard.js';

export interface SearchResult {
  title?: string;
  url?: string;
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
  readonly searchEnabled: boolean;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
  fetch(url: string): Promise<FetchedPage>;
}

export interface OllamaWebOptions {
  apiKey?: string;
  fetch?: typeof fetch;
  lookup?: Lookup;
  timeoutMs?: number;
}

const MAX_BODY_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;

/**
 * Web search via the Ollama web search API (needs OLLAMA_API_KEY).
 * Web fetch via the Ollama web fetch API, falling back to a guarded direct fetch.
 */
export class OllamaWebClient implements WebClient {
  private readonly ollama?: Ollama;
  private readonly fetchImpl: typeof fetch;
  private readonly lookup: Lookup;
  private readonly timeoutMs: number;

  constructor(options: OllamaWebOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.lookup = options.lookup ?? defaultLookup;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (options.apiKey) {
      this.ollama = new Ollama({
        host: 'https://ollama.com',
        fetch: this.fetchImpl,
        headers: { Authorization: `Bearer ${options.apiKey}` },
      });
    }
  }

  get searchEnabled(): boolean {
    return this.ollama !== undefined;
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    if (!this.ollama) {
      throw new Error('Web search is unavailable: OLLAMA_API_KEY is not configured. Ask the user to paste the information instead.');
    }
    const response = await this.ollama.webSearch({ query, maxResults });
    return (response.results as SearchResult[]).map((r) => ({ title: r.title, url: r.url, content: r.content }));
  }

  async fetch(url: string): Promise<FetchedPage> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Only http(s) URLs are allowed: ${url}`);
    if (this.ollama) {
      try {
        const page = await this.ollama.webFetch({ url });
        return { url: page.url || url, title: page.title ?? '', content: page.content ?? '', links: page.links?.slice(0, 50), source: 'ollama' };
      } catch {
        // fall through to a direct fetch
      }
    }
    return this.directFetch(url);
  }

  private async directFetch(startUrl: string): Promise<FetchedPage> {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(url, this.lookup);
      const response = await this.fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; cv-writer/0.5)',
          Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        url = new URL(response.headers.get('location')!, url).toString();
        continue;
      }
      if (!response.ok) throw new Error(`Fetching ${url} failed with HTTP ${response.status}`);
      const type = response.headers.get('content-type') ?? '';
      if (!/text\/|json|xml/.test(type) && type !== '') throw new Error(`Unsupported content type "${type}" at ${url}`);
      const raw = await readLimited(response, MAX_BODY_BYTES);
      const isHtml = /html|xml/.test(type) || /^\s*</.test(raw);
      return {
        url,
        title: isHtml ? extractTitle(raw) : '',
        content: isHtml ? htmlToText(raw) : raw,
        source: 'direct',
      };
    }
    throw new Error(`Too many redirects fetching ${startUrl}`);
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}
