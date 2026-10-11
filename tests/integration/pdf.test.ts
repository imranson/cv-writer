import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationService } from '../../src/agents/conversation.ts';
import { buildCvDocument } from '../../src/cv/document.ts';
import { countPdfPages, PdfRenderer } from '../../src/cv/pdf.ts';
import { DEFAULT_STYLE, STYLE_PRESETS } from '../../src/cv/styles.ts';
import { createApp } from '../../src/server/app.ts';
import { CV_HTML, LISTING, longCv, PROFILE } from '../support/fixtures.ts';
import { makeEnv } from '../support/env.ts';
import { client } from '../support/http.ts';

const renderer = new PdfRenderer();
let server: Server;
let origin: string;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.setHeader('Content-Type', req.url?.endsWith('.css') ? 'text/css' : 'text/plain');
    res.end(req.url?.endsWith('.css') ? 'h1 { color: red; }' : 'ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await renderer.close();
  await new Promise((r) => server.close(r));
});

function mediaBox(pdf: Buffer): [number, number] {
  const m = pdf.toString('latin1').match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  return [Number(m?.[1]), Number(m?.[2])];
}

describe('PdfRenderer (headless Chromium)', () => {
  it('renders a one-page CV to a real PDF', async () => {
    const { pdf, pageCount } = await renderer.render(buildCvDocument({ html: CV_HTML, css: DEFAULT_STYLE }));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount).toBe(1);
    expect(countPdfPages(pdf)).toBe(1);
  });

  it('paginates long CVs and responds to font-size changes in the CSS', async () => {
    const html = longCv(6);
    const small = await renderer.render(buildCvDocument({ html, css: DEFAULT_STYLE }));
    const large = await renderer.render(buildCvDocument({ html, css: DEFAULT_STYLE.replace('--base-size: 10pt', '--base-size: 16pt') }));
    expect(small.pageCount).toBeGreaterThanOrEqual(2);
    expect(large.pageCount).toBeGreaterThan(small.pageCount);
  });

  it('honours the @page size from the stylesheet', async () => {
    const a4 = await renderer.render(buildCvDocument({ html: CV_HTML, css: DEFAULT_STYLE }));
    const letter = await renderer.render(buildCvDocument({ html: CV_HTML, css: DEFAULT_STYLE.replace('size: A4', 'size: Letter') }));
    const [aw, ah] = mediaBox(a4.pdf);
    const [lw, lh] = mediaBox(letter.pdf);
    expect(Math.round(aw)).toBe(595);
    expect(Math.round(ah)).toBe(842);
    expect([Math.round(lw), Math.round(lh)]).toEqual([612, 792]);
  });

  it('renders every style preset', async () => {
    for (const preset of STYLE_PRESETS) {
      const { pageCount } = await renderer.render(buildCvDocument({ html: CV_HTML, css: preset.css }));
      expect(pageCount, preset.id).toBe(1);
    }
  });

  it('blocks network access and never runs scripts', async () => {
    hits.length = 0;
    const doc = `<!doctype html><html><head><link rel="stylesheet" href="${origin}/blocked.css"></head><body><img src="${origin}/img.png"><script>fetch('${origin}/js')</script><h1>Hi</h1></body></html>`;
    await renderer.render(doc);
    expect(hits).toEqual([]);

    const allowed = new PdfRenderer({ allowedHosts: ['127.0.0.1'] });
    try {
      await allowed.render(doc);
      expect(hits).toContain('/blocked.css');
      expect(hits).not.toContain('/js');
    } finally {
      await allowed.close();
    }
  });

  it('handles concurrent renders and relaunches after close', async () => {
    const doc = buildCvDocument({ html: CV_HTML, css: DEFAULT_STYLE });
    const results = await Promise.all([renderer.render(doc), renderer.render(doc), renderer.render(doc)]);
    expect(results.map((r) => r.pageCount)).toEqual([1, 1, 1]);
    await renderer.close();
    expect((await renderer.render(doc)).pageCount).toBe(1);
  });
});

describe('PDF endpoint with the real renderer', () => {
  it('downloads a styled PDF for a job CV', async () => {
    const env = await makeEnv();
    const pdf = new PdfRenderer();
    try {
      env.deps.pdf = pdf;
      const api = client(createApp({ deps: env.deps, conversation: new ConversationService(env.deps, { compactThreshold: 0.8 }) }));
      await env.store.writeProfile(PROFILE);
      const job = await env.store.createJob({ title: 'Senior PM', company: 'Brightwave', listing: LISTING });
      await env.store.writeCv(job.id, longCv(6));
      await env.store.writeStyle(job.id, STYLE_PRESETS.find((p) => p.id === 'compact')!.css);
      const res = await api.get(`/api/jobs/${job.id}/pdf?download=1`);
      expect(res.status).toBe(200);
      expect((res.data as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(Number(res.headers.get('x-page-count'))).toBe(countPdfPages(res.data));
      const checks = (await api.get(`/api/jobs/${job.id}/checks`)).data;
      expect(checks.pageCount).toBe(Number(res.headers.get('x-page-count')));
    } finally {
      await pdf.close();
      await env.cleanup();
    }
  });
});

describe('countPdfPages', () => {
  it('counts page objects but not the page tree', () => {
    expect(countPdfPages(Buffer.from('<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page >>'))).toBe(2);
  });
});
