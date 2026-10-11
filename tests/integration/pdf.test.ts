import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightPdfRenderer } from '../../src/cv/pdf.js';
import { renderCvDocument } from '../../src/cv/render.js';
import { buildTestApp } from '../support/app.js';
import { ADA_CV_HTML } from '../support/journey.js';
import { ScriptedLLM } from '../support/scriptedLlm.js';

function mediaBox(pdf: Buffer): number[] {
  const match = /\/MediaBox\s*\[\s*([\d.\s-]+)\]/.exec(pdf.toString('latin1'));
  if (!match) throw new Error('No MediaBox');
  return match[1].trim().split(/\s+/).map(Number);
}

function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

describe('PDF rendering with Playwright', () => {
  const renderer = new PlaywrightPdfRenderer();
  let tracker: Server;
  let hits: string[] = [];
  let base = '';

  beforeAll(async () => {
    tracker = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('x');
    });
    await new Promise<void>((r) => tracker.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(tracker.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await renderer.close();
    tracker.close();
  });

  it('renders a one-page A4 PDF from the CV HTML and default CSS', async () => {
    const t = await buildTestApp(new ScriptedLLM({}), renderer);
    try {
      await t.workspace.saveJob('job-acme', 'p1', { title: 'Engineer', company: 'Acme' });
      await t.workspace.saveCv('job-acme', { html: ADA_CV_HTML });
      const res = await t.app.request('/api/cvs/job-acme/pdf?download=1');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="cv-job-acme.pdf"');
      const pdf = Buffer.from(await res.arrayBuffer());
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pageCount(pdf)).toBe(1);
      const [, , w, h] = mediaBox(pdf);
      expect(w).toBeCloseTo(595, 0); // A4 in points
      expect(h).toBeCloseTo(842, 0);
    } finally {
      // renderer is shared; only remove the temp data
      await t.cleanup().catch(() => {});
    }
  });

  it('uses the per-CV pageSize preference when the CSS sets no page size', async () => {
    const doc = renderCvDocument('<h1>Ada</h1>', 'body { font-family: serif; }');
    const pdf = await renderer.render(doc, { format: 'Letter' });
    const [, , w, h] = mediaBox(pdf);
    expect(w).toBeCloseTo(612, 0);
    expect(h).toBeCloseTo(792, 0);
  });

  it('paginates long CVs', async () => {
    const long = '<ul>' + Array.from({ length: 150 }, (_, i) => `<li>Achievement number ${i}</li>`).join('') + '</ul>';
    expect(pageCount(await renderer.render(renderCvDocument(long, 'body{font-size:12pt}')))).toBeGreaterThan(1);
  });

  it('runs no scripts and makes no network requests while rendering', async () => {
    hits = [];
    const html = `<h1>Ada</h1>
      <img src="${base}/img.png">
      <link rel="stylesheet" href="${base}/style.css">
      <script>fetch('${base}/script'); document.body.innerHTML = 'HACKED';</script>`;
    const css = `@import url("${base}/import.css"); body { background: url("${base}/bg.png"); }`;
    const pdf = await renderer.render(renderCvDocument(html, css));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    await new Promise((r) => setTimeout(r, 100));
    expect(hits).toEqual([]);
  });
});
