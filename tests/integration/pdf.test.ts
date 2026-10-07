import { describe, expect, it } from 'vitest';
import { chromePdfRenderer, countPdfPages, findChrome, isCompletePdf } from '../../src/cv/pdf.js';
import { renderHtml } from '../../src/cv/render.js';
import { mergeStyle } from '../../src/cv/style.js';
import { DEFAULT_STYLE, type CvDocument } from '../../src/domain/schemas.js';
import { CV_DOC } from '../support/fixtures.js';

const chrome = await findChrome();
const mediaBox = (pdf: Buffer) => /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(pdf.toString('latin1'))!.slice(1).map((n) => Math.round(Number(n)));
const fontNames = (pdf: Buffer) => new Set(pdf.toString('latin1').match(/\/FontName\s*\/[A-Z]{6}\+([^\s/]+)/g)?.map((f) => f.replace(/.*\+/, '')) ?? []);

describe.skipIf(!chrome)('PDF output with real Chrome', () => {
  const print = chromePdfRenderer(chrome!);

  it('prints a one-page CV on A4 by default and on US Letter when asked', async () => {
    const a4 = await print(renderHtml(CV_DOC, DEFAULT_STYLE));
    expect(isCompletePdf(a4)).toBe(true);
    expect(countPdfPages(a4)).toBe(1);
    expect(mediaBox(a4)).toEqual([595, 842]);
    const letter = await print(renderHtml(CV_DOC, mergeStyle(DEFAULT_STYLE, { pageSize: 'Letter' })));
    expect(mediaBox(letter)).toEqual([612, 792]);
  });

  it('changes the typeface in the PDF', async () => {
    const serif = fontNames(await print(renderHtml(CV_DOC, mergeStyle(DEFAULT_STYLE, { fontFamily: 'georgia' }))));
    const sans = fontNames(await print(renderHtml(CV_DOC, mergeStyle(DEFAULT_STYLE, { fontFamily: 'helvetica' }))));
    expect(serif.size).toBeGreaterThan(0);
    expect([...serif].sort()).not.toEqual([...sans].sort());
  });

  it('spacing, size and margins change how much fits on a page', async () => {
    const long: CvDocument = structuredClone(CV_DOC);
    const exp = long.sections[0]!;
    if (exp.kind !== 'entries') throw new Error();
    for (let i = 0; i < 6; i++) exp.items.push({ ...exp.items[0]!, heading: `Role ${i}` });
    const tight = await print(renderHtml(long, mergeStyle(DEFAULT_STYLE, { preset: 'compact' })));
    const airy = await print(renderHtml(long, mergeStyle(DEFAULT_STYLE, { preset: 'airy', baseFontSize: 13, marginVerticalMm: 30 })));
    expect(countPdfPages(airy)!).toBeGreaterThan(countPdfPages(tight)!);
  });

  it('fails clearly when Chrome cannot be started', async () => {
    await expect(chromePdfRenderer('/nonexistent/chrome', 2000)('<p>x</p>')).rejects.toThrow(/Could not start Chrome|exited without/);
  });
});
