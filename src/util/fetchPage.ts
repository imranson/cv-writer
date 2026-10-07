export interface FetchedPage {
  url: string;
  title?: string;
  company?: string;
  location?: string;
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Readable text from HTML: drops scripts, styles and navigation chrome, keeps paragraph and list structure. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/ul|\/ol|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface JobPostingLd {
  '@type'?: string | string[];
  title?: string;
  description?: string;
  hiringOrganization?: { name?: string } | string;
  jobLocation?: { address?: { addressLocality?: string; addressCountry?: string | { name?: string } } } | Array<unknown>;
}

/** Many job boards embed a schema.org JobPosting; it is cleaner than the page text. */
export function findJobPosting(html: string): JobPostingLd | undefined {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    try {
      const data = JSON.parse(json) as unknown;
      const candidates = (Array.isArray(data) ? data : [data, ...((data as { '@graph'?: unknown[] })?.['@graph'] ?? [])]) as JobPostingLd[];
      const posting = candidates.find((d) => {
        const t = d?.['@type'];
        return t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
      });
      if (posting) return posting;
    } catch {
      // malformed JSON-LD; ignore
    }
  }
  return undefined;
}

export async function fetchPage(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Promise<FetchedPage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs can be fetched');
  const res = await fetchImpl(parsed, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', Accept: 'text/html,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`The page returned HTTP ${res.status}. Ask the user to paste the listing instead.`);
  const html = await res.text();
  const posting = findJobPosting(html);
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '');
  if (posting?.description) {
    const org = typeof posting.hiringOrganization === 'string' ? posting.hiringOrganization : posting.hiringOrganization?.name;
    const loc = Array.isArray(posting.jobLocation) ? undefined : posting.jobLocation?.address?.addressLocality;
    return {
      url: parsed.href,
      ...(posting.title ? { title: decodeEntities(posting.title) } : title ? { title } : {}),
      ...(org ? { company: decodeEntities(org) } : {}),
      ...(loc ? { location: loc } : {}),
      text: htmlToText(decodeEntities(posting.description)),
    };
  }
  const text = htmlToText(html);
  if (text.length < 200) throw new Error('The page had almost no readable text (it may need JavaScript or a login). Ask the user to paste the listing instead.');
  return { url: parsed.href, ...(title ? { title } : {}), text };
}
