import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { decodeEntities, htmlToText } from './html.js';

export type FetchLike = typeof fetch;

export interface WebOptions {
  /** Ollama API key: enables Ollama's hosted web_search / web_fetch APIs. */
  apiKey?: string;
  fetchImpl?: FetchLike;
  /** Hostname resolver (injectable for tests). */
  resolve?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA = 'Mozilla/5.0 (compatible; CVWriterBot/1.0; +https://github.com/)';

// ---------- SSRF protection ----------

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

/** Throws unless the URL is http(s) and resolves only to public addresses. */
export async function assertPublicUrl(raw: string, resolve = defaultResolve): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs can be fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('Refusing to fetch a private/internal address');
  }
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error('Refusing to fetch a private/internal address');
  }
  return url;
}

async function timedFetch(f: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await f(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- search ----------

export async function webSearch(query: string, maxResults = 5, opts: WebOptions = {}): Promise<SearchResult[]> {
  const f = opts.fetchImpl ?? fetch;
  const max = Math.min(Math.max(1, maxResults), 10);
  if (opts.apiKey) {
    const res = await timedFetch(
      f,
      'https://ollama.com/api/web_search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ query, max_results: max }),
      },
      opts.timeoutMs ?? 20_000,
    );
    if (!res.ok) throw new Error(`Ollama web search failed: HTTP ${res.status}`);
    const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (json.results ?? []).slice(0, max).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, 600),
    }));
  }
  // Keyless fallback: DuckDuckGo's HTML endpoint.
  const res = await timedFetch(
    f,
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { 'user-agent': UA, accept: 'text/html' } },
    opts.timeoutMs ?? 20_000,
  );
  if (!res.ok) throw new Error(`Web search failed: HTTP ${res.status}`);
  return parseDuckDuckGo(await res.text()).slice(0, max);
}

export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i.exec(block)?.[1] ?? '';
    let url = decodeEntities(a[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    else if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    results.push({ title: clean(a[2]), url, snippet: clean(snippet) });
  }
  return results;
}

// ---------- fetch ----------

export interface FetchedPage {
  url: string;
  title: string;
  content: string;
  truncated: boolean;
  links?: { text: string; url: string }[];
}

export async function webFetch(rawUrl: string, opts: WebOptions & { maxChars?: number } = {}): Promise<FetchedPage> {
  const f = opts.fetchImpl ?? fetch;
  const maxChars = opts.maxChars ?? 20_000;
  try {
    return await directFetch(rawUrl, f, maxChars, opts);
  } catch (err) {
    if (!opts.apiKey || /private\/internal|Only http/.test(String(err))) throw err;
    // Fall back to Ollama's hosted fetcher (handles sites that block plain HTTP clients).
    const res = await timedFetch(
      f,
      'https://ollama.com/api/web_fetch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ url: rawUrl }),
      },
      opts.timeoutMs ?? 25_000,
    );
    if (!res.ok) throw new Error(`${(err as Error).message}; Ollama web_fetch also failed: HTTP ${res.status}`);
    const json = (await res.json()) as { title?: string; content?: string; links?: string[] };
    const content = json.content ?? '';
    return {
      url: rawUrl,
      title: json.title ?? '',
      content: content.slice(0, maxChars),
      truncated: content.length > maxChars,
    };
  }
}

async function directFetch(rawUrl: string, f: FetchLike, maxChars: number, opts: WebOptions): Promise<FetchedPage> {
  let current = rawUrl;
  for (let hop = 0; hop < 5; hop++) {
    const url = await assertPublicUrl(current, opts.resolve);
    const res = await timedFetch(
      f,
      url.toString(),
      { redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' } },
      opts.timeoutMs ?? 20_000,
    );
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    const raw = (await res.text()).slice(0, 2_000_000);
    if (/html|xml/.test(type) || /^\s*</.test(raw)) {
      const page = htmlToText(raw, url.toString());
      return {
        url: url.toString(),
        title: page.title,
        content: page.text.slice(0, maxChars),
        truncated: page.text.length > maxChars,
        links: page.links.slice(0, 30),
      };
    }
    return { url: url.toString(), title: '', content: raw.slice(0, maxChars), truncated: raw.length > maxChars };
  }
  throw new Error('Too many redirects');
}
