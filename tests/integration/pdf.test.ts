import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countPdfPages, PdfRenderer } from '../../src/pdf/renderer.js';
import { DEFAULT_CSS } from '../../src/cv/defaults.js';
import { createTestEnv, TestClient } from '../helpers/env.js';

const renderer = new PdfRenderer();
let hits = 0;
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits++;
    res.end('x');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await renderer.close();
  await new Promise((r) => server.close(r));
});

const cv = '<header class="cv-header"><h1>Ann Example</h1><p class="cv-headline">Engineer</p></header><section><h2>Experience</h2><ul><li>Built things</li></ul></section>';
const mediaBox = (pdf: Buffer) => /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(pdf.toString('latin1'))!.slice(1).map(Number);

describe('Playwright PDF rendering', () => {
  it('renders a one-page A4 PDF with the CV stylesheet', async () => {
    const pdf = await renderer.render(cv, DEFAULT_CSS, { paperSize: 'A4' }, { title: 'CV' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(countPdfPages(pdf)).toBe(1);
    const [w, h] = mediaBox(pdf);
    expect(Math.abs(w - 595.3)).toBeLessThan(1.5); // A4 = 210 × 297 mm
    expect(Math.abs(h - 841.9)).toBeLessThan(1.5);
  });

  it('honours Letter paper size from preferences', async () => {
    const [w, h] = mediaBox(await renderer.render(cv, DEFAULT_CSS, { paperSize: 'Letter' }));
    expect([Math.round(w), Math.round(h)]).toEqual([612, 792]);
  });

  it('counts pages for long CVs (used to enforce maxPages)', async () => {
    const long = cv + '<section><h2>More</h2><ul>' + '<li>Delivered a measurable improvement to a critical system used by many people.</li>'.repeat(140) + '</ul></section>';
    expect(await renderer.countPages(long, DEFAULT_CSS, {})).toBeGreaterThanOrEqual(3);
  });

  it('never runs scripts in CV HTML', async () => {
    const script = `<script>for (let i = 0; i < 400; i++) document.body.insertAdjacentHTML('beforeend', '<p>injected</p>');</script>`;
    expect(await renderer.countPages(cv + script, DEFAULT_CSS, {})).toBe(1);
  });

  it('blocks network requests from CV HTML and CSS', async () => {
    hits = 0;
    await renderer.render(`${cv}<img src="${base}/pixel.png">`, `@import url("${base}/evil.css"); body { background: url("${base}/bg.png"); }`, {});
    expect(hits).toBe(0);
  });

  it('handles concurrent renders', async () => {
    const pdfs = await Promise.all(Array.from({ length: 5 }, () => renderer.render(cv, DEFAULT_CSS, {})));
    expect(pdfs.every((p) => countPdfPages(p) === 1)).toBe(true);
  });

  it('serves real PDFs through the API', async () => {
    const env = await createTestEnv({ pdf: renderer });
    const client = new TestClient(env.app);
    await client.register('pdf@example.com', 'password123', 'Pat Doe');
    const { body } = await client.json('POST', '/api/jobs', { job: { title: 'Analyst', company: 'Initech' } });
    await client.json('PUT', `/api/jobs/${body.job.id}/cv`, { html: cv });
    const res = await client.req('GET', `/api/jobs/${body.job.id}/cv.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-page-count')).toBe('1');
    expect(res.headers.get('content-disposition')).toContain('CV - Pat Doe - Initech - Analyst.pdf');
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    await env.close();
  });
});
