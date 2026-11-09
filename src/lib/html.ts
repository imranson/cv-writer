/** HTML helpers: readable-text extraction (web fetch) and safe CV document assembly (preview + PDF). */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface ExtractedPage {
  title: string;
  text: string;
  links: { text: string; url: string }[];
}

export function htmlToText(html: string, baseUrl?: string): ExtractedPage {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '');
  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head|title)\b[\s\S]*?<\/\1>/gi, '');
  const links: ExtractedPage['links'] = [];
  body = body.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text && !href.startsWith('javascript:') && !href.startsWith('#') && links.length < 100) {
      let url = href;
      try {
        url = new URL(decodeEntities(href), baseUrl).toString();
      } catch {
        /* keep raw */
      }
      links.push({ text, url });
    }
    return inner;
  });
  const text = decodeEntities(
    body
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|blockquote|pre|main|nav|aside)>/gi, '\n')
      .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n${'#'.repeat(Number(n))} `)
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text, links };
}

/**
 * Strips anything executable from agent-written CV HTML. Preview iframes are sandboxed and the PDF
 * renderer disables JavaScript too; this is defence in depth and keeps stored HTML clean.
 */
export function sanitizeCvHtml(html: string): string {
  return html
    .replace(/<(script|iframe|object|frameset|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|frame|frameset|base|form|noscript)\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action|formaction)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

/** Reduces a full HTML document to its body content so the CV is always stored as a fragment. */
export function extractBody(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (body) return body[1].trim();
  return html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?(html|head)\b[^>]*>/gi, '').replace(/<title[\s\S]*?<\/title>/i, '').trim();
}

/** Builds the standalone HTML document used for the preview iframe and the Playwright PDF. */
export function buildCvDocument(html: string, css: string, title = 'CV'): string {
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  const content = sanitizeCvHtml(extractBody(html)) || '<p style="color:#888;font-family:sans-serif">No CV yet — ask the assistant to write one.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${safeCss}</style>
</head>
<body>
${content}
</body>
</html>`;
}

export function countWords(html: string): number {
  const text = decodeEntities(
    html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '),
  );
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
