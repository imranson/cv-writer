import type { Ollama } from 'ollama';

export interface FetchedPage {
  url: string;
  title?: string;
  text: string;
}

export type PageFetcher = (url: string) => Promise<FetchedPage>;

export const MAX_PAGE_CHARS = 30_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Readable text from an HTML page: scripts and styles dropped, block elements on their own lines. */
export function htmlToText(html: string): { title?: string; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|head|title)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|li|tr|table|dl|dt|dd|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const cleaned = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const t = title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : undefined;
  return { ...(t ? { title: t } : {}), text: cleaned };
}

export function assertWebUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) URLs can be fetched');
  return parsed;
}

const truncate = (text: string) =>
  text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n\n[… page truncated at ${MAX_PAGE_CHARS} characters]` : text;

/** Plain HTTP GET; works for most static job boards. */
export function directFetcher(fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): PageFetcher {
  return async (url) => {
    assertWebUrl(url);
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (cv-writer)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`The page returned HTTP ${res.status}`);
    const body = await res.text();
    const isHtml = (res.headers.get('content-type') ?? '').includes('html') || /^\s*<(!doctype|html)/i.test(body);
    const { title, text } = isHtml ? htmlToText(body) : { title: undefined, text: body.trim() };
    if (!text) throw new Error('The page has no readable text (it may need JavaScript). Ask the user to paste the listing.');
    return { url: res.url || url, ...(title ? { title } : {}), text: truncate(text) };
  };
}

/** Ollama's hosted web fetch (needs OLLAMA_API_KEY); renders pages a plain GET can't read. */
export function ollamaWebFetcher(ollama: Pick<Ollama, 'webFetch'>): PageFetcher {
  return async (url) => {
    assertWebUrl(url);
    const page = await ollama.webFetch({ url });
    if (!page.content?.trim()) throw new Error('Ollama web fetch returned no content');
    return { url: page.url || url, ...(page.title ? { title: page.title } : {}), text: truncate(page.content.trim()) };
  };
}

/** Tries each fetcher in turn, reporting every failure if none works. */
export function firstWorking(...fetchers: PageFetcher[]): PageFetcher {
  return async (url) => {
    const errors: string[] = [];
    for (const fetcher of fetchers) {
      try {
        return await fetcher(url);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    throw new Error(`Could not fetch ${url}: ${errors.join('; ')}`);
  };
}
