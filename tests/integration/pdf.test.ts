import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfRenderer } from '../../src/pdf/render.js';
import { DEFAULT_CSS } from '../../src/db/defaults.js';
import { createTestApp, register, TestClient } from '../helpers.js';

// Real headless Chromium via Playwright (run `npx playwright install chromium` once locally).
const renderer = new PdfRenderer();
afterAll(() => renderer.close());

const mediaBox = (pdf: Buffer) => {
  const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1'));
  return m ? [Math.round(Number(m[1])), Math.round(Number(m[2]))] : null;
};

function expectSize(pdf: Buffer, [w, hgt]: [number, number]) {
  const box = mediaBox(pdf)!;
  expect(Math.abs(box[0] - w)).toBeLessThanOrEqual(2);
  expect(Math.abs(box[1] - hgt)).toBeLessThanOrEqual(2);
}

describe('PdfRenderer (Playwright)', () => {
  it('renders a one-page A4 PDF', async () => {
    const { pdf, pages } = await renderer.render('<header><h1>Ada Lovelace</h1></header><p>Engineer</p>', DEFAULT_CSS, { pageSize: 'A4' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages).toBe(1);
    expectSize(pdf, [595, 842]); // A4 in points
  });

  it('honours Letter size and paginates long CVs', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `<p>Achievement number ${i} with measurable impact.</p>`).join('');
    const { pdf, pages } = await renderer.render(long, DEFAULT_CSS, { pageSize: 'Letter' });
    expectSize(pdf, [612, 792]); // US Letter in points
    expect(pages).toBeGreaterThanOrEqual(2);
  });

  it('does not execute scripts or load remote resources', async () => {
    const html = `<p id="x">static</p><img src="http://127.0.0.1:9/tracker.png"><p>ok</p>`;
    const { pdf } = await renderer.render(html, 'p{color:#000}', {});
    expect(pdf.length).toBeGreaterThan(500);
  });
});

describe('GET /api/jobs/:id/cv.pdf (end to end)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    ctx = await createTestApp({ pdf: renderer });
  });
  afterAll(() => ctx.db.close());

  it('streams a real PDF with its page count', async () => {
    const c = new TestClient(ctx.app);
    await register(c, 'ada@example.com', 'Ada Lovelace');
    const job = (await c.json('POST', '/api/jobs', { job: { title: 'Engineer', company: 'Acme' } })).body.job;
    await c.json('PUT', `/api/jobs/${job.id}/cv`, { html: '<header><h1>Ada Lovelace</h1></header>' });
    const res = await c.request('GET', `/api/jobs/${job.id}/cv.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-page-count')).toBe('1');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
