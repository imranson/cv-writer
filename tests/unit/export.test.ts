import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromePdfArgs, exportCv, findChrome, slugify } from '../../src/cv/export.js';
import { sampleCv, tempDir } from '../helpers.js';

describe('findChrome', () => {
  it('prefers CHROME_PATH', async () => {
    expect(await findChrome({ CHROME_PATH: '/x/chrome' }, 'darwin', async () => false)).toBe('/x/chrome');
  });

  it('returns the first installed candidate for the platform', async () => {
    const installed = new Set(['/usr/bin/chromium']);
    expect(await findChrome({}, 'linux', async (p) => installed.has(p))).toBe('/usr/bin/chromium');
  });

  it('returns undefined when nothing is installed or the platform is unknown', async () => {
    expect(await findChrome({}, 'darwin', async () => false)).toBeUndefined();
    expect(await findChrome({}, 'aix', async () => true)).toBeUndefined();
  });
});

describe('chromePdfArgs', () => {
  it('prints headlessly to the target without headers', () => {
    const args = chromePdfArgs('/tmp/my cv.html', '/tmp/out.pdf');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--no-pdf-header-footer');
    expect(args).toContain('--print-to-pdf=/tmp/out.pdf');
    expect(args.at(-1)).toBe('file:///tmp/my%20cv.html');
  });
});

describe('slugify', () => {
  it('makes filesystem-safe names', () => {
    expect(slugify('Zoë O’Brien — CV')).toBe('zoe-o-brien-cv');
    expect(slugify('***')).toBe('cv');
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });
});

describe('exportCv', () => {
  it('writes Markdown and HTML, and PDF through the renderer', async () => {
    const dir = await tempDir();
    const calls: string[][] = [];
    const result = await exportCv({
      doc: sampleCv(),
      outDir: path.join(dir, 'out'),
      baseName: 'alex-cv',
      pdf: async (html, pdf) => {
        calls.push([html, pdf]);
        await writeFile(pdf, '%PDF-1.4');
      },
    });
    expect(result.warnings).toEqual([]);
    expect(result.exports).toEqual({
      markdown: path.join(dir, 'out', 'alex-cv.md'),
      html: path.join(dir, 'out', 'alex-cv.html'),
      pdf: path.join(dir, 'out', 'alex-cv.pdf'),
    });
    expect(calls).toEqual([[result.exports.html, result.exports.pdf]]);
    expect(await readFile(result.exports.markdown, 'utf8')).toMatch(/^# Alex Morgan/);
    expect(await readFile(result.exports.html, 'utf8')).toContain('<h1>Alex Morgan</h1>');
  });

  it('still exports Markdown and HTML when PDF rendering fails or is unavailable', async () => {
    const dir = await tempDir();
    const failed = await exportCv({
      doc: sampleCv(),
      outDir: dir,
      baseName: 'a',
      pdf: async () => {
        throw new Error('boom');
      },
    });
    expect(failed.exports.pdf).toBeUndefined();
    expect(failed.warnings[0]).toMatch(/PDF export failed \(boom\)/);

    const none = await exportCv({ doc: sampleCv(), outDir: dir, baseName: 'b' });
    expect(none.exports.pdf).toBeUndefined();
    expect(none.warnings[0]).toMatch(/No Chrome\/Chromium found/);
  });
});
