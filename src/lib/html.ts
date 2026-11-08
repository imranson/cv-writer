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
  copy: '©',
  reg: '®',
  trade: '™',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
  middot: '·',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Converts an HTML page into readable plain text (used by webFetch fallback and CV stats). */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '');
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(p|div|section|article|header|footer|h[1-6]|ul|ol|table|blockquote)\b[^>]*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/(p|div|section|article|header|footer|h[1-6]|tr|ul|ol|table|main|aside|nav|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

/**
 * Defence-in-depth cleanup of agent-written CV HTML. The preview iframe is fully
 * sandboxed and the PDF renderer disables JavaScript, so this only needs to strip
 * obviously active content and keep the stored document a plain fragment.
 */
export function sanitizeCvHtml(html: string): string {
  let out = html;
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(out);
  if (body) out = body[1];
  return out
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?(html|head|body)\b[^>]*>/gi, '')
    // Paired elements: drop the element and everything inside it.
    .replace(/<(script|style|iframe|object|embed|noscript|template|form)\b[\s\S]*?<\/\1\s*>/gi, '')
    // Unclosed, void or stray tags of dangerous kinds.
    .replace(/<\/?(script|style|iframe|object|embed|noscript|template|form|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .trim();
}

export interface CvDocumentOptions {
  title?: string;
  lang?: string;
}

/** Assembles the stored HTML fragment and CSS into a standalone printable document. */
export function buildCvDocument(html: string, css: string, opts: CvDocumentOptions = {}): string {
  const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(opts.lang ?? '') ? opts.lang : 'en';
  const body = html.trim() || '<p class="cv-empty">This CV has not been written yet.</p>';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title ?? 'CV')}</title>
<style>
${css.replace(/<\/style/gi, '<\\/style')}
</style>
</head>
<body>
${body}
</body>
</html>`;
}
