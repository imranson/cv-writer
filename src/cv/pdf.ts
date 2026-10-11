import { chromium, type Browser } from 'playwright';

export interface PdfRendererOptions {
  /** Hosts the page may load resources from (e.g. web fonts). All other network access is blocked. */
  allowedHosts?: string[];
  timeoutMs?: number;
}

export interface RenderedPdf {
  pdf: Buffer;
  pageCount: number;
}

/** Counts pages in a PDF produced by Chromium (each page is a `/Type /Page` object). */
export function countPdfPages(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?!s)\b/g) ?? []).length;
}

/**
 * Renders full HTML documents to PDF with headless Chromium. The browser is launched lazily
 * and reused; each render gets an isolated context with JavaScript disabled.
 */
export class PdfRenderer {
  private browser: Promise<Browser> | null = null;
  private readonly allowedHosts: Set<string>;
  private readonly timeoutMs: number;

  constructor(opts: PdfRendererOptions = {}) {
    this.allowedHosts = new Set(opts.allowedHosts ?? []);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const launching = chromium.launch({ headless: true });
      this.browser = launching;
      launching
        .then((b) => b.on('disconnected', () => (this.browser = null)))
        .catch(() => (this.browser = null));
    }
    return this.browser;
  }

  async render(documentHtml: string): Promise<RenderedPdf> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        const allowed = url.protocol === 'data:' || url.protocol === 'about:' || this.allowedHosts.has(url.hostname);
        return allowed ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(this.timeoutMs);
      await page.setContent(documentHtml, { waitUntil: 'load' });
      await page.emulateMedia({ media: 'print' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      return { pdf, pageCount: countPdfPages(pdf) };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const pending = this.browser;
    this.browser = null;
    if (pending) await (await pending.catch(() => null))?.close();
  }
}

export interface PdfService {
  render(documentHtml: string): Promise<RenderedPdf>;
  close(): Promise<void>;
}
