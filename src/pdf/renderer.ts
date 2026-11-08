import type { Browser } from 'playwright';
import { buildCvDocument } from '../lib/html.js';
import { paperSizeOf } from '../cv/defaults.js';
import type { PageCounter } from '../agents/tool.js';

const ALLOWED_REMOTE = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

/** Counts page objects in a PDF produced by Chromium. */
export function countPdfPages(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

export interface RenderOptions {
  title?: string;
}

/**
 * Renders CV HTML + CSS to PDF with headless Chromium (Playwright).
 * JavaScript is disabled and all network access is blocked except Google Fonts,
 * so agent-written HTML cannot execute code or reach internal services.
 */
export class PdfRenderer implements PageCounter {
  private browser?: Promise<Browser>;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly maxConcurrent = 3) {}

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = import('playwright')
        .then(({ chromium }) => chromium.launch({ headless: true, chromiumSandbox: process.getuid?.() !== 0 }))
        .catch((err) => {
          this.browser = undefined;
          throw new Error(`Could not start Chromium for PDF rendering (run "npm run browsers"): ${err.message}`);
        });
    }
    return this.browser;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  async render(html: string, css: string, preferences: Record<string, unknown> = {}, opts: RenderOptions = {}): Promise<Buffer> {
    await this.acquire();
    const browser = await this.getBrowser().catch((err) => {
      this.release();
      throw err;
    });
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => {
        const url = route.request().url();
        return url.startsWith('data:') || ALLOWED_REMOTE.test(url) ? route.continue() : route.abort('blockedbyclient');
      });
      const lang = typeof preferences.language === 'string' ? preferences.language : undefined;
      await page.setContent(buildCvDocument(html, css, { title: opts.title, lang }), { waitUntil: 'load', timeout: 15_000 });
      await page.emulateMedia({ media: 'print' });
      return await page.pdf({ format: paperSizeOf(preferences), printBackground: true, preferCSSPageSize: false });
    } finally {
      await context.close().catch(() => {});
      this.release();
    }
  }

  async countPages(html: string, css: string, preferences: Record<string, unknown> = {}): Promise<number> {
    return countPdfPages(await this.render(html, css, preferences));
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await (await browser.catch(() => undefined))?.close();
  }
}
