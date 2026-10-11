import { describe, expect, it } from 'vitest';
import { STYLE_PRESETS } from '../../../src/cv/styles.ts';
import { getCssVar, getPageSize, lengthToPx, parsePt, setCssVar, setPageSize, toHexColour } from '../../../web/src/cssvars.ts';

const css = STYLE_PRESETS[0]!.css;

describe('quick style controls', () => {
  it('reads and updates CSS variables in place', () => {
    expect(getCssVar(css, 'accent')).toBe('#1f4e79');
    const next = setCssVar(css, 'accent', '#ff0000');
    expect(getCssVar(next, 'accent')).toBe('#ff0000');
    expect(next.length).toBe(css.length);
    expect(getCssVar(setCssVar(':root {\n}', 'new', '1pt'), 'new')).toBe('1pt');
    expect(setCssVar('body {}', 'x', '1')).toBe(':root { --x: 1; }\nbody {}');
  });

  it('reads and updates the @page size', () => {
    expect(getPageSize(css)).toBe('A4');
    const letter = setPageSize(css, 'Letter');
    expect(getPageSize(letter)).toBe('Letter');
    expect(letter).toContain('margin: 14mm 16mm');
    expect(getPageSize(setPageSize('@page { margin: 1in; }', 'A4'))).toBe('A4');
    expect(setPageSize('body {}', 'A4')).toMatch(/^@page \{ size: A4; \}/);
    expect(getPageSize('body {}')).toBeNull();
  });

  it('parses points, colours and lengths', () => {
    expect(parsePt('10.5pt')).toBe(10.5);
    expect(parsePt('1em')).toBeNull();
    expect(toHexColour('#ABC')).toBe('#aabbcc');
    expect(toHexColour('#1F4E79')).toBe('#1f4e79');
    expect(toHexColour('red')).toBeNull();
    expect(Math.round(lengthToPx('210mm'))).toBe(794);
    expect(lengthToPx('8.5in')).toBe(816);
    expect(lengthToPx('72pt')).toBe(96);
    expect(lengthToPx('nonsense')).toBe(794);
  });
});
