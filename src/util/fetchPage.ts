import { decodeEntities, htmlToText, truncate } from './text.ts';

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

export interface FetchPageOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxChars?: number;
  /** Allow loopback/private-network hosts (tests only). */
  allowPrivate?: boolean;
}

export class FetchPageError extends Error {}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1?\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;

export function assertPublicHttpUrl(raw: string, allowPrivate = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchPageError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchPageError('Only http(s) URLs can be fetched');
  if (!allowPrivate && PRIVATE_HOST.test(url.hostname)) throw new FetchPageError('Refusing to fetch a private or local address');
  return url;
}

/** Keeps the main page content: drops navigation, footers, scripts and other chrome. */
export function extractMainText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  let body = html.replace(/<(nav|footer|aside|form|button|iframe)\b[\s\S]*?<\/\1>/gi, '');
  const main = body.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? body.match(/<article\b[\s\S]*?<\/article>/i)?.[0];
  if (main && htmlToText(main).length > 300) body = main;
  return { title, text: htmlToText(body) };
}

export async function fetchPage(rawUrl: string, opts: FetchPageOptions = {}): Promise<FetchedPage> {
  const url = assertPublicHttpUrl(rawUrl, opts.allowPrivate);
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (CV Writer job-listing fetcher)', Accept: 'text/html,text/plain;q=0.9' },
    });
  } catch (err) {
    throw new FetchPageError(`Could not fetch ${url.href}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new FetchPageError(`Fetching ${url.href} failed with HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  const body = await res.text();
  const maxChars = opts.maxChars ?? 20_000;
  if (type.includes('text/plain')) return { url: res.url || url.href, title: '', text: truncate(body.trim(), maxChars) };
  if (type && !type.includes('html')) throw new FetchPageError(`Unsupported content type: ${type}`);
  const { title, text } = extractMainText(body);
  return { url: res.url || url.href, title, text: truncate(text, maxChars) };
}
