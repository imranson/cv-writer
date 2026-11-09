import type { Browser } from 'playwright';
import { buildCvDocument } from '../lib/html.js';

export type PageSize = 'A4' | 'Letter';

export interface PdfResult {
  pdf: Buffer;
  pages: number;
}

const ALLOWED_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

/** Counts pages in a Chromium-generated PDF (page objects are not stream-compressed). */
export function countPdfPages(pdf: Buffer): number {
  const matches = pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return matches ? matches.length : 0;
}

/**
 * Renders CV HTML + CSS to PDF with headless Chromium (Playwright). One browser is launched lazily
 * and reused; each render gets an isolated context with JavaScript disabled and network access
 * limited to Google Fonts.
 */
export class PdfRenderer {
  private browser: Promise<Browser> | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = import('playwright').then(({ chromium }) =>
        chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'] }),
      );
      this.browser.then(
        (b) => b.on('disconnected', () => (this.browser = null)),
        () => (this.browser = null),
      );
    }
    return this.browser;
  }

  async render(html: string, css: string, opts: { pageSize?: PageSize; title?: string } = {}): Promise<PdfResult> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.protocol === 'data:' || url.protocol === 'about:' || ALLOWED_HOSTS.has(url.hostname)) return route.continue();
        return route.abort();
      });
      await page.setContent(buildCvDocument(html, css, opts.title), { waitUntil: 'load', timeout: 20_000 });
      await page.emulateMedia({ media: 'print' });
      const pdf = await page.pdf({
        format: opts.pageSize ?? 'A4',
        printBackground: true,
        preferCSSPageSize: true,
      });
      return { pdf, pages: countPdfPages(pdf) };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b).close().catch(() => {});
  }
}

export function normalizePageSize(value: unknown): PageSize {
  return String(value).toLowerCase() === 'letter' ? 'Letter' : 'A4';
}
