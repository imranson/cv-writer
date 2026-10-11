import { chromium, type Browser } from 'playwright';

export interface PdfOptions {
  /** Paper format used when the CSS has no `@page { size }` rule, e.g. "A4" or "Letter". */
  format?: string;
}

export interface PdfRenderer {
  render(documentHtml: string, options?: PdfOptions): Promise<Buffer>;
  close(): Promise<void>;
}

/** Renders CV documents to PDF with headless Chromium. Scripts and network access are disabled. */
export class PlaywrightPdfRenderer implements PdfRenderer {
  private browser?: Promise<Browser>;

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = chromium.launch().catch((err) => {
        this.browser = undefined;
        throw new Error(`Could not start Chromium for PDF rendering (run "npx playwright install chromium"): ${err.message}`);
      });
    }
    return this.browser;
  }

  async render(documentHtml: string, options: PdfOptions = {}): Promise<Buffer> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      await page.setContent(documentHtml, { waitUntil: 'load' });
      return await page.pdf({
        format: options.format ?? 'A4',
        preferCSSPageSize: true,
        printBackground: true,
      });
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await (await browser.catch(() => undefined))?.close();
  }
}
