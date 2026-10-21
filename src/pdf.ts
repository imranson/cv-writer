import { chromium, type Browser } from 'playwright';
import type { CvPreferences } from './store';
import { escapeHtml } from './util/text';

/** Hosts the CV document may load from (web fonts only). */
const ALLOWED_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

export const DOCUMENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data: https:";

/** Wraps the CV body fragment and its stylesheet into a standalone HTML document. */
export function buildCvDocument(html: string, css: string, opts: { title?: string; lang?: string } = {}): string {
  const lang = (opts.lang || 'en').split(/[-_]/)[0].replace(/[^a-z]/gi, '') || 'en';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">
<title>${escapeHtml(opts.title || 'CV')}</title>
<style>
/* On-screen preview only: mimic the printed page margins. The CV stylesheet below can override. */
@media screen { html { background: #fff; } body { padding: 14mm 16mm; } }
</style>
<style>
${css.replace(/<\/style/gi, '<\\/style')}
</style>
</head>
<body>
${html}
</body>
</html>`;
}

export function countPdfPages(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

export class PdfRenderer {
  private browser?: Promise<Browser>;

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = chromium.launch().catch((err) => {
        this.browser = undefined;
        throw err;
      });
    }
    return this.browser;
  }

  async render(document: string, prefs: Pick<CvPreferences, 'pageSize'>): Promise<{ pdf: Buffer; pages: number }> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.protocol === 'data:' || (url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname))) return route.continue();
        return route.abort();
      });
      await page.setContent(document, { waitUntil: 'load', timeout: 15_000 });
      await page.emulateMedia({ media: 'print' });
      const pdf = await page.pdf({
        format: prefs.pageSize === 'Letter' ? 'Letter' : 'A4',
        preferCSSPageSize: true,
        printBackground: true,
      });
      return { pdf, pages: countPdfPages(pdf) };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await (await browser).close().catch(() => {});
  }
}
