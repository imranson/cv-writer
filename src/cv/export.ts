import path from 'node:path';
import type { CvExport, CvVersion, Style } from '../domain/schemas.js';
import type { Store } from '../storage/store.js';
import { slugify } from '../util/ids.js';
import { countPdfPages, isPdf, writeFileEnsured, type PdfRenderer } from './pdf.js';
import { renderHtml, renderMarkdown } from './render.js';

export interface ExportResult {
  cv: CvVersion;
  export: CvExport;
  warnings: string[];
}

/**
 * Writes the submission files for one CV version — PDF (when a browser is available), the HTML it
 * was printed from, and Markdown — and records the export, with the exact style used, on the version.
 */
export async function exportCv(params: {
  store: Store;
  jobId: string;
  version: number;
  style: Style;
  pdf?: PdfRenderer;
}): Promise<ExportResult> {
  const { store, jobId, version, style } = params;
  const cv = await store.getCvVersion(jobId, version);
  const base = `${slugify(cv.document.name, 40)}-cv-v${version}`;
  const dir = store.outputDir(jobId);
  const html = renderHtml(cv.document, style);
  const files = { html: path.join(dir, `${base}.html`), markdown: path.join(dir, `${base}.md`), pdf: path.join(dir, `${base}.pdf`) };
  await writeFileEnsured(files.html, html);
  await writeFileEnsured(files.markdown, renderMarkdown(cv.document));

  const warnings: string[] = [];
  let pages: number | undefined;
  let pdfPath: string | undefined;
  if (params.pdf) {
    try {
      const bytes = await params.pdf(html);
      if (!isPdf(bytes)) throw new Error('the browser did not produce a PDF');
      await writeFileEnsured(files.pdf, bytes);
      pdfPath = files.pdf;
      pages = countPdfPages(bytes);
      if (pages && pages > 2) warnings.push(`The PDF is ${pages} pages; most employers expect one or two.`);
    } catch (err) {
      warnings.push(`PDF generation failed: ${(err as Error).message}`);
    }
  } else {
    warnings.push('No Chrome/Chromium found (set CHROME_PATH), so only HTML and Markdown were written.');
  }

  const record: CvExport = {
    at: new Date().toISOString(),
    html: files.html,
    markdown: files.markdown,
    ...(pdfPath ? { pdf: pdfPath } : {}),
    ...(pages ? { pages } : {}),
    style,
  };
  const updated = await store.updateCvVersion(jobId, version, (v) => ({ ...v, exports: [...v.exports, record] }));
  return { cv: updated, export: record, warnings };
}
