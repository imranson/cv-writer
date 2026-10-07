import { z } from 'zod';
import { DEFAULT_STYLE, StyleSchema, type Style } from '../domain/schemas.js';

export interface FontChoice {
  id: string;
  label: string;
  stack: string;
  kind: 'serif' | 'sans' | 'mono';
}

/** Typefaces with fallbacks so a CV still prints sensibly where the first choice is not installed. */
export const FONTS: FontChoice[] = [
  { id: 'georgia', label: 'Georgia', stack: "Georgia, 'Times New Roman', serif", kind: 'serif' },
  { id: 'garamond', label: 'EB Garamond', stack: "'EB Garamond', Garamond, 'Times New Roman', serif", kind: 'serif' },
  { id: 'charter', label: 'Charter', stack: "Charter, 'Bitstream Charter', Georgia, serif", kind: 'serif' },
  { id: 'source-serif', label: 'Source Serif 4', stack: "'Source Serif 4', 'Source Serif Pro', Georgia, serif", kind: 'serif' },
  { id: 'literata', label: 'Literata', stack: "Literata, Georgia, serif", kind: 'serif' },
  { id: 'palatino', label: 'Palatino', stack: "Palatino, 'Palatino Linotype', 'Book Antiqua', serif", kind: 'serif' },
  { id: 'baskerville', label: 'Baskerville', stack: "Baskerville, 'Baskerville Old Face', Georgia, serif", kind: 'serif' },
  { id: 'iowan', label: 'Iowan Old Style', stack: "'Iowan Old Style', Palatino, Georgia, serif", kind: 'serif' },
  { id: 'times', label: 'Times New Roman', stack: "'Times New Roman', Times, serif", kind: 'serif' },
  { id: 'helvetica', label: 'Helvetica Neue', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif", kind: 'sans' },
  { id: 'avenir', label: 'Avenir Next', stack: "'Avenir Next', Avenir, 'Segoe UI', sans-serif", kind: 'sans' },
  { id: 'gill-sans', label: 'Gill Sans', stack: "'Gill Sans', 'Gill Sans MT', Calibri, sans-serif", kind: 'sans' },
  { id: 'optima', label: 'Optima', stack: "Optima, Candara, 'Segoe UI', sans-serif", kind: 'sans' },
  { id: 'system', label: 'System UI', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", kind: 'sans' },
  { id: 'arial', label: 'Arial', stack: 'Arial, Helvetica, sans-serif', kind: 'sans' },
  { id: 'menlo', label: 'Menlo', stack: "Menlo, Consolas, 'Courier New', monospace", kind: 'mono' },
];

export const STYLE_PRESETS: Record<string, Partial<Style>> = {
  classic: { fontFamily: 'garamond', headingFontFamily: 'same', baseFontSize: 11, headerAlign: 'center', sectionTitleStyle: 'caps-rule', accentColor: '#222222' },
  modern: { fontFamily: 'helvetica', headingFontFamily: 'same', baseFontSize: 10, headerAlign: 'left', sectionTitleStyle: 'caps', accentColor: '#1f3a5f' },
  compact: { baseFontSize: 9.5, lineHeight: 1.2, marginVerticalMm: 10, marginHorizontalMm: 12, sectionSpacingPt: 7, itemSpacingPt: 4, bulletSpacingPt: 0.5 },
  airy: { baseFontSize: 11, lineHeight: 1.45, marginVerticalMm: 20, marginHorizontalMm: 22, sectionSpacingPt: 16, itemSpacingPt: 9, bulletSpacingPt: 2.5 },
};

/** Every style field optional and without defaults, for partial updates. */
export const stylePatchShape = Object.fromEntries(
  Object.entries(StyleSchema.shape).map(([key, schema]) => [key, schema.unwrap().optional()]),
) as unknown as { [K in keyof Style]: z.ZodOptional<z.ZodType<Style[K]>> };
export const StylePatchSchema = z.object(stylePatchShape);

/** A known font id, or a quoted custom family name with a generic fallback. */
export function fontStack(id: string, fallback = DEFAULT_STYLE.fontFamily): string {
  const known = FONTS.find((f) => f.id === id);
  if (known) return known.stack;
  const custom = id.replace(/["';{}<>\\]/g, '').trim();
  if (custom) return `"${custom}", ${fontStack(fallback)}`;
  return fontStack(fallback);
}

/** Applies a partial change (from the UI or the coordinator) to the current style, validating the result. */
export function mergeStyle(current: Style, patch: Partial<Record<keyof Style, unknown>> & { preset?: string }): Style {
  const { preset, ...rest } = patch;
  let base: Style = current;
  if (preset) {
    const p = STYLE_PRESETS[preset];
    if (!p) throw new Error(`Unknown preset "${preset}". Presets: ${Object.keys(STYLE_PRESETS).join(', ')}`);
    base = { ...current, ...p };
  }
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return StyleSchema.parse({ ...base, ...defined });
}

export function describeStyle(style: Style): string {
  const font = FONTS.find((f) => f.id === style.fontFamily)?.label ?? style.fontFamily;
  const heading = style.headingFontFamily === 'same' ? 'same' : (FONTS.find((f) => f.id === style.headingFontFamily)?.label ?? style.headingFontFamily);
  return `${font} ${style.baseFontSize}pt (headings: ${heading}), line height ${style.lineHeight}, ${style.pageSize}, margins ${style.marginVerticalMm}/${style.marginHorizontalMm} mm, spacing section ${style.sectionSpacingPt}pt / item ${style.itemSpacingPt}pt / bullet ${style.bulletSpacingPt}pt, accent ${style.accentColor}, header ${style.headerAlign}, section titles ${style.sectionTitleStyle}`;
}

export function styleCss(style: Style): string {
  const body = fontStack(style.fontFamily);
  const heading = style.headingFontFamily === 'same' ? body : fontStack(style.headingFontFamily);
  const [w, h] = style.pageSize === 'A4' ? ['210mm', '297mm'] : ['8.5in', '11in'];
  const titleRule = style.sectionTitleStyle === 'caps-rule' ? `border-bottom: 0.6pt solid ${style.accentColor}; padding-bottom: 1.5pt;` : '';
  const titleCase = style.sectionTitleStyle === 'plain' ? 'none' : 'uppercase';
  const bullet = JSON.stringify(style.bulletChar);
  return `
@page { size: ${style.pageSize}; margin: ${style.marginVerticalMm}mm ${style.marginHorizontalMm}mm; }
:root { --accent: ${style.accentColor}; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #e9e9ec; color: #1b1b1b; font-family: ${body}; font-size: ${style.baseFontSize}pt; line-height: ${style.lineHeight}; }
.page { background: #fff; width: ${w}; min-height: ${h}; margin: 16px auto; padding: ${style.marginVerticalMm}mm ${style.marginHorizontalMm}mm; box-shadow: 0 1px 6px rgba(0,0,0,.18); }
@media print { body { background: #fff; } .page { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; } }
header.cv-header { text-align: ${style.headerAlign}; margin-bottom: ${style.sectionSpacingPt}pt; }
.cv-name { font-family: ${heading}; font-size: ${style.nameFontSize}pt; line-height: 1.1; margin: 0; color: var(--accent); font-weight: 600; }
.cv-headline { margin: 2pt 0 0; font-size: 1.08em; }
.cv-contact { margin: 3pt 0 0; font-size: 0.92em; color: #444; }
.cv-contact span + span::before { content: "  ·  "; white-space: pre; color: #999; }
.cv-contact a { color: inherit; text-decoration: none; }
section.cv-section { margin-top: ${style.sectionSpacingPt}pt; }
.cv-section > h2 { font-family: ${heading}; font-size: 1.05em; letter-spacing: ${titleCase === 'uppercase' ? '0.06em' : '0'}; text-transform: ${titleCase}; color: var(--accent); margin: 0 0 ${Math.max(2, style.itemSpacingPt * 0.6)}pt; font-weight: 700; ${titleRule} }
.cv-summary { margin: 0; }
.cv-item { margin-top: ${style.itemSpacingPt}pt; break-inside: avoid; }
.cv-item:first-of-type { margin-top: 0; }
.cv-item-head { display: flex; justify-content: space-between; gap: 8pt; align-items: baseline; }
.cv-item-title { font-weight: 700; }
.cv-item-sub { font-style: italic; }
.cv-item-meta { white-space: nowrap; color: #444; font-size: 0.95em; text-align: right; }
.cv-item-summary { margin: 1pt 0 0; }
ul.cv-bullets { margin: ${style.bulletSpacingPt + 1}pt 0 0; padding-left: 1.1em; list-style: none; }
ul.cv-bullets li { margin-top: ${style.bulletSpacingPt}pt; }
/* In-flow hanging bullet (no positioning), so PDF text extraction and ATS parsers read lines in order. */
ul.cv-bullets li::before { content: ${bullet}; display: inline-block; width: 1.1em; margin-left: -1.1em; color: var(--accent); }
.cv-skills { margin: 0; padding: 0; list-style: none; }
.cv-skills li { margin-top: ${style.bulletSpacingPt}pt; }
.cv-skills b { font-weight: 700; }
.cv-text { margin: 0; white-space: pre-line; }
`;
}
