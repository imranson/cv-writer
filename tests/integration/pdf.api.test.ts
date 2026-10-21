import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfRenderer } from '../../src/pdf';
import { makeDeps, tempDir } from '../helpers';
import { TestClient, buildApp } from '../helpers/http';

let tmp: Awaited<ReturnType<typeof tempDir>>;
let pdf: PdfRenderer;
let client: TestClient;
let jobId: string;

beforeAll(async () => {
  tmp = await tempDir();
  pdf = new PdfRenderer();
  client = new TestClient(buildApp(makeDeps(tmp.dir), pdf));
  await client.register('ada@example.com');
  jobId = (await client.post('/api/jobs', { title: 'Data Engineer', company: 'Acme Ltd' })).body.job.id;
});
afterAll(async () => {
  await pdf.close();
  await tmp.cleanup();
});

async function getPdf(query = '') {
  const res = await client.request('GET', `/api/jobs/${jobId}/cv.pdf${query}`);
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe('PDF rendering with Playwright', () => {
  it('renders the CV with its CSS to a PDF', async () => {
    await client.put(`/api/jobs/${jobId}/cv`, { html: '<h1>Ada Lovelace</h1><p>Analytical engines.</p>' });
    const { res, bytes } = await getPdf();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="CV-Acme-Ltd-Data-Engineer.pdf"');
    expect(res.headers.get('x-page-count')).toBe('1');
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  });

  it('offers a download disposition', async () => {
    const { res } = await getPdf('?download=1');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('respects page size and reports multi-page CVs', async () => {
    await client.put(`/api/jobs/${jobId}/css`, { css: '@page { size: Letter; margin: 10mm } p { height: 200mm; margin: 0 }' });
    await client.put(`/api/jobs/${jobId}/cv`, { html: '<p>Page one</p><p>Page two</p>' });
    const { res, bytes } = await getPdf();
    expect(res.headers.get('x-page-count')).toBe('2');
    // US Letter is 612 × 792 points.
    expect(Buffer.from(bytes).toString('latin1')).toMatch(/\/MediaBox \[0 0 612 792\]/);
  });

  it('does not load external resources or run scripts', async () => {
    await client.put(`/api/jobs/${jobId}/css`, { css: 'body { background: url("http://127.0.0.1:1/leak.png") }' });
    await client.put(`/api/jobs/${jobId}/cv`, { html: '<img src="http://127.0.0.1:1/x.png"><p>Safe</p>' });
    const { res } = await getPdf();
    expect(res.status).toBe(200);
  });
});
