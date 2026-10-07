import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCv } from '../../src/cv/checks.js';
import { exportCv } from '../../src/cv/export.js';
import { chromePdfArgs, countPdfPages, findChrome, isPdf } from '../../src/cv/pdf.js';
import { DEFAULT_STYLE } from '../../src/domain/schemas.js';
import type { Store } from '../../src/storage/store.js';
import { CV_DOC, PROFILE, seededStore, tempDir } from '../support/fixtures.js';

describe('pdf helpers', () => {
  it('finds a browser from CHROME_PATH or known locations', async () => {
    expect(await findChrome({ CHROME_PATH: '/x/chrome' })).toBe('/x/chrome');
    expect(await findChrome({}, 'linux', async (p) => p === '/usr/bin/chromium')).toBe('/usr/bin/chromium');
    expect(await findChrome({}, 'aix' as NodeJS.Platform, async () => true)).toBeUndefined();
  });

  it('prints headless with a throwaway profile and no header/footer', () => {
    const args = chromePdfArgs('/tmp/a b/cv.html', '/tmp/out.pdf', '/tmp/profile');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--user-data-dir=/tmp/profile');
    expect(args).toContain('--no-pdf-header-footer');
    expect(args).toContain('--print-to-pdf=/tmp/out.pdf');
    expect(args.at(-1)).toBe('file:///tmp/a%20b/cv.html');
  });

  it('counts pages and recognises PDFs', () => {
    const pdf = Buffer.from('%PDF-1.4 /Type /Pages /Kids [] /Type /Page /Type/Page ');
    expect(countPdfPages(pdf)).toBe(2);
    expect(countPdfPages(Buffer.from('nothing'))).toBeUndefined();
    expect(isPdf(pdf)).toBe(true);
    expect(isPdf(Buffer.from('<html>'))).toBe(false);
  });
});

describe('exportCv', () => {
  let cleanup: () => Promise<void>;
  let store: Store;
  let jobId: string;
  beforeEach(async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    ({ store, jobId } = (await seededStore(t.dir, { job: true })) as { store: Store; jobId: string });
    await store.addCvVersion({ jobId, profileRevision: 1, writerRunId: 'w', document: CV_DOC, checks: checkCv(CV_DOC, PROFILE) });
  });
  afterEach(() => cleanup());

  it('writes PDF, HTML and Markdown, and records the export with its style', async () => {
    let printed = '';
    const threePages = Buffer.from('%PDF-1.7 /Type /Page /Type /Page /Type /Page');
    const r = await exportCv({ store, jobId, version: 1, style: { ...DEFAULT_STYLE, fontFamily: 'times' }, pdf: async (html) => ((printed = html), threePages) });
    expect(printed).toContain("'Times New Roman'");
    expect(r.export.pages).toBe(3);
    expect(r.warnings).toEqual(['The PDF is 3 pages; most employers expect one or two.']);
    expect(await readFile(r.export.pdf!, 'latin1')).toMatch(/^%PDF/);
    expect(await readFile(r.export.markdown, 'utf8')).toMatch(/^# Ada Lovelace/);
    expect(await readFile(r.export.html, 'utf8')).toContain('Analytical Engines Ltd');
    expect((await store.getCvVersion(jobId, 1)).exports).toHaveLength(1);
  });

  it('still writes HTML and Markdown when no browser is available or printing fails', async () => {
    const none = await exportCv({ store, jobId, version: 1, style: DEFAULT_STYLE });
    expect(none.export.pdf).toBeUndefined();
    expect(none.warnings[0]).toMatch(/No Chrome/);
    const broken = await exportCv({ store, jobId, version: 1, style: DEFAULT_STYLE, pdf: async () => Buffer.from('<html>') });
    expect(broken.warnings[0]).toMatch(/PDF generation failed: the browser did not produce a PDF/);
    expect((await store.getCvVersion(jobId, 1)).exports).toHaveLength(2);
  });
});
