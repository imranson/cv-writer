import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { CvDocument, CvExports } from '../domain/schemas.js';
import { renderHtml, renderMarkdown } from './render.js';

const CHROME_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

export async function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => Promise<boolean> = (p) => access(p).then(() => true, () => false),
): Promise<string | undefined> {
  if (env.CHROME_PATH) return env.CHROME_PATH;
  for (const candidate of CHROME_CANDIDATES[platform] ?? []) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

export function chromePdfArgs(htmlPath: string, pdfPath: string): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];
}

export type PdfRenderer = (htmlPath: string, pdfPath: string) => Promise<void>;

/** Prints the HTML to PDF with a headless Chromium-family browser. */
export function chromePdfRenderer(chromePath: string, timeoutMs = 60_000): PdfRenderer {
  const run = promisify(execFile);
  return async (htmlPath, pdfPath) => {
    await run(chromePath, chromePdfArgs(htmlPath, pdfPath), { timeout: timeoutMs });
    await access(pdfPath);
  };
}

export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'cv'
  );
}

export interface ExportResult {
  exports: CvExports;
  warnings: string[];
}

/** Writes the submission files: Markdown, print-ready HTML and (when a browser is available) PDF. */
export async function exportCv(params: {
  doc: CvDocument;
  outDir: string;
  baseName: string;
  pdf?: PdfRenderer;
}): Promise<ExportResult> {
  const { doc, outDir, baseName, pdf } = params;
  await mkdir(outDir, { recursive: true });
  const markdown = path.join(outDir, `${baseName}.md`);
  const html = path.join(outDir, `${baseName}.html`);
  await writeFile(markdown, renderMarkdown(doc));
  await writeFile(html, renderHtml(doc));

  const warnings: string[] = [];
  let pdfPath: string | undefined;
  if (pdf) {
    const target = path.join(outDir, `${baseName}.pdf`);
    try {
      await pdf(html, target);
      pdfPath = target;
    } catch (err) {
      warnings.push(`PDF export failed (${(err as Error).message}); print ${html} to PDF from a browser instead.`);
    }
  } else {
    warnings.push(`No Chrome/Chromium found for PDF export (set CHROME_PATH); print ${html} to PDF from a browser instead.`);
  }
  return { exports: { markdown, html, ...(pdfPath ? { pdf: pdfPath } : {}) }, warnings };
}
