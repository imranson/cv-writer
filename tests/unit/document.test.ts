import { describe, expect, it } from 'vitest';
import { buildCvDocument, parsePageBox, previewCss } from '../../src/cv/document.ts';
import { DEFAULT_STYLE, getPreset, STYLE_PRESETS } from '../../src/cv/styles.ts';

describe('buildCvDocument', () => {
  it('wraps sanitised CV markup and CSS in a complete document', () => {
    const doc = buildCvDocument({ html: '<h1>Jo</h1><script>x</script>', css: 'h1 { color: red; }', title: 'CV <Jo>' });
    expect(doc).toMatch(/^<!doctype html>/);
    expect(doc).toContain('<title>CV &lt;Jo&gt;</title>');
    expect(doc).toContain('<style>h1 { color: red; }</style>');
    expect(doc).toContain('<main class="cv">\n<h1>Jo</h1>\n</main>');
    expect(doc).not.toContain('<script>');
  });

  it('adds paper-like screen styling only for previews', () => {
    expect(buildCvDocument({ html: '', css: '' })).not.toContain('@media screen');
    expect(buildCvDocument({ html: '', css: '', preview: true })).toContain('@media screen');
  });
});

describe('parsePageBox', () => {
  it('reads named sizes, orientation, explicit sizes and margins', () => {
    expect(parsePageBox('@page { size: A4; margin: 14mm 16mm; }')).toEqual({ width: '210mm', height: '297mm', margin: '14mm 16mm' });
    expect(parsePageBox('@page { size: letter; }')).toMatchObject({ width: '8.5in', height: '11in' });
    expect(parsePageBox('@page { size: A4 landscape; }')).toMatchObject({ width: '297mm', height: '210mm' });
    expect(parsePageBox('@page { size: 200mm 280mm; }')).toMatchObject({ width: '200mm', height: '280mm' });
    expect(parsePageBox('body {}')).toEqual({ width: '210mm', height: '297mm', margin: '15mm' });
  });

  it('uses the page box in the preview CSS', () => {
    expect(previewCss('@page { size: letter; margin: 1in; }')).toContain('width: 8.5in; min-height: 11in; padding: 1in;');
  });
});

describe('style presets', () => {
  it('ships several presets that define an @page rule and the variables used by quick controls', () => {
    expect(STYLE_PRESETS.map((p) => p.id)).toEqual(['classic', 'modern', 'compact']);
    for (const p of STYLE_PRESETS) {
      expect(p.css).toMatch(/@page\s*\{[^}]*size:/);
      expect(p.css).toMatch(/--accent:/);
      expect(p.css).toMatch(/--base-size:\s*[\d.]+pt/);
    }
    expect(getPreset('classic')?.css).toBe(DEFAULT_STYLE);
    expect(getPreset('nope')).toBeUndefined();
  });
});
