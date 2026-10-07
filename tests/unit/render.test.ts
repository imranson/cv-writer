import { describe, expect, it } from 'vitest';
import { escapeHtml, renderHtml, renderMarkdown } from '../../src/cv/render.js';
import { describeStyle, fontStack, FONTS, mergeStyle, STYLE_PRESETS, StylePatchSchema, styleCss } from '../../src/cv/style.js';
import { DEFAULT_STYLE, StyleSchema } from '../../src/domain/schemas.js';
import { CV_DOC } from '../support/fixtures.js';

describe('renderHtml', () => {
  it('renders every part of the CV', () => {
    const html = renderHtml(CV_DOC, DEFAULT_STYLE);
    expect(html).toMatch(/^<!doctype html>/);
    for (const text of ['Ada Lovelace', 'Analytical Engines Ltd', 'Sep 2021 – Present', 'First-class honours', 'Cloud &amp; tools:', 'mailto:ada@example.com', 'href="https://github.com/ada"'])
      expect(html).toContain(text);
  });

  it('escapes model-written text so it cannot inject markup', () => {
    const doc = structuredClone(CV_DOC);
    doc.summary = '<script>alert(1)</script> & "quotes"';
    const html = renderHtml(doc, DEFAULT_STYLE);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(escapeHtml(`'`)).toBe('&#39;');
  });

  it('applies the style: typeface, sizes, page and margins, spacing, colours', () => {
    const style = mergeStyle(DEFAULT_STYLE, { fontFamily: 'garamond', baseFontSize: 9.5, pageSize: 'Letter', marginVerticalMm: 10, marginHorizontalMm: 12, sectionSpacingPt: 4, accentColor: '#aa0000', headerAlign: 'center', bulletChar: '–' });
    const css = styleCss(style);
    expect(css).toContain("font-family: 'EB Garamond'");
    expect(css).toContain('font-size: 9.5pt');
    expect(css).toContain('@page { size: Letter; margin: 10mm 12mm; }');
    expect(css).toContain('section.cv-section { margin-top: 4pt; }');
    expect(css).toContain('--accent: #aa0000');
    expect(css).toContain('text-align: center');
    expect(css).toContain('content: "–"');
    expect(renderHtml(CV_DOC, style)).toContain(css);
  });
});

describe('ATS friendliness', () => {
  it('keeps every element in normal flow so PDF text is extracted in reading order', () => {
    const css = styleCss(DEFAULT_STYLE);
    expect(css).not.toMatch(/position:\s*(absolute|fixed|relative)/);
    expect(css).not.toMatch(/float:/);
  });
});

describe('renderMarkdown', () => {
  it('produces readable Markdown', () => {
    const md = renderMarkdown(CV_DOC);
    expect(md).toContain('# Ada Lovelace');
    expect(md).toContain('## Experience');
    expect(md).toContain('**Software Engineer**, *Analytical Engines Ltd* — London · Sep 2021 – Present');
    expect(md).toContain('- Built a Python payments API');
    expect(md).toContain('- **Languages:** Python, TypeScript, SQL');
  });
});

describe('style', () => {
  it('maps font ids to stacks and quotes custom families safely', () => {
    expect(fontStack('helvetica')).toContain('Helvetica Neue');
    expect(fontStack('Fira Sans')).toBe(`"Fira Sans", ${FONTS[0]!.stack}`);
    expect(fontStack('x"; } body { color: red')).not.toMatch(/[";{}]\s*body/);
  });

  it('applies presets, then explicit fields on top', () => {
    const s = mergeStyle(DEFAULT_STYLE, { preset: 'compact', baseFontSize: 10 });
    expect(s.marginVerticalMm).toBe(STYLE_PRESETS.compact!.marginVerticalMm);
    expect(s.baseFontSize).toBe(10);
    expect(() => mergeStyle(DEFAULT_STYLE, { preset: 'nope' })).toThrow(/Unknown preset/);
  });

  it('validates ranges and colours', () => {
    expect(() => mergeStyle(DEFAULT_STYLE, { baseFontSize: 40 })).toThrow();
    expect(() => mergeStyle(DEFAULT_STYLE, { accentColor: 'red' })).toThrow(/hex colour/);
    expect(mergeStyle(DEFAULT_STYLE, { baseFontSize: '11' }).baseFontSize).toBe(11);
  });

  it('has a patch schema without defaults', () => {
    expect(StylePatchSchema.parse({})).toEqual({});
    expect(StylePatchSchema.parse({ lineHeight: '1.4' })).toEqual({ lineHeight: 1.4 });
    expect(StyleSchema.parse({})).toEqual(DEFAULT_STYLE);
  });

  it('describes a style in words', () => {
    expect(describeStyle(DEFAULT_STYLE)).toMatch(/^Georgia 10\.5pt .*A4, margins 15\/17 mm/);
  });
});
