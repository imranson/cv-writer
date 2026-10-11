export interface StylePreset {
  id: string;
  name: string;
  description: string;
  css: string;
}

const BASE = `* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: var(--font-body); font-size: var(--base-size); line-height: var(--line-height); color: var(--text); }
a { color: inherit; text-decoration: none; }
p { margin: 3pt 0; }
ul { margin: 3pt 0 0; padding-left: 13pt; }
li { margin: 1.5pt 0; }
h2, h3 { break-after: avoid; }
.entry { break-inside: avoid; }
.entry-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8pt; }
.dates { white-space: nowrap; }
.skill-groups { list-style: none; padding: 0; }
.skill-groups li { margin: 1pt 0; }`;

const CLASSIC = `/* Classic — serif headings, centred header.
   Variables below control most of the look; everything else is plain CSS. */
@page { size: A4; margin: 14mm 16mm; }

:root {
  --font-body: "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-heading: Georgia, "Times New Roman", serif;
  --text: #1f2328;
  --muted: #57606a;
  --accent: #1f4e79;
  --rule: #c9d1d9;
  --base-size: 10pt;
  --line-height: 1.38;
}

${BASE}

header { text-align: center; margin-bottom: 8pt; }
h1 { font-family: var(--font-heading); font-size: 22pt; font-weight: 600; letter-spacing: 0.5pt; margin: 0; color: var(--accent); }
.headline { margin: 2pt 0 4pt; font-size: 11pt; color: var(--muted); }
.contact { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; justify-content: center; gap: 0 12pt; font-size: 9pt; color: var(--muted); }

section { margin-top: 9pt; }
h2 { font-family: var(--font-heading); font-size: 11.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 1pt;
     color: var(--accent); border-bottom: 0.75pt solid var(--rule); padding-bottom: 2pt; margin: 0 0 5pt; }
h3 { font-size: 10.5pt; margin: 0; font-weight: 600; }
.org { font-weight: 400; }
.org::before { content: " · "; color: var(--muted); }
.dates, .entry-meta { font-size: 9pt; color: var(--muted); }
.entry { margin-bottom: 7pt; }
.entry-meta { margin: 0; font-style: italic; }
`;

const MODERN = `/* Modern — sans-serif, left-aligned header, accent bars. */
@page { size: A4; margin: 13mm 15mm; }

:root {
  --font-body: "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --text: #16181d;
  --muted: #5b6270;
  --accent: #0f766e;
  --rule: #e2e8f0;
  --base-size: 9.8pt;
  --line-height: 1.42;
}

${BASE}

header { border-left: 4pt solid var(--accent); padding-left: 10pt; margin-bottom: 10pt; }
h1 { font-size: 24pt; font-weight: 700; letter-spacing: -0.3pt; margin: 0; }
.headline { margin: 1pt 0 5pt; font-size: 11pt; font-weight: 500; color: var(--accent); }
.contact { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 0 14pt; font-size: 8.8pt; color: var(--muted); }

section { margin-top: 10pt; }
h2 { font-size: 10pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2pt; color: var(--accent); margin: 0 0 5pt; }
h2::after { content: ""; display: block; height: 1pt; background: var(--rule); margin-top: 2pt; }
h3 { font-size: 10.3pt; margin: 0; font-weight: 650; }
.org { font-weight: 500; color: var(--muted); }
.org::before { content: " — "; }
.dates { font-size: 8.8pt; color: var(--muted); font-variant-numeric: tabular-nums; }
.entry { margin-bottom: 8pt; }
.entry-meta { margin: 0; font-size: 8.8pt; color: var(--muted); }
li::marker { color: var(--accent); }
`;

const COMPACT = `/* Compact — dense single-column layout for fitting more on fewer pages. */
@page { size: A4; margin: 10mm 12mm; }

:root {
  --font-body: Arial, "Helvetica Neue", Helvetica, sans-serif;
  --text: #111;
  --muted: #555;
  --accent: #222;
  --rule: #bbb;
  --base-size: 9pt;
  --line-height: 1.28;
}

${BASE}

header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; border-bottom: 1pt solid var(--accent); padding-bottom: 3pt; margin-bottom: 5pt; }
h1 { font-size: 17pt; margin: 0; }
.headline { margin: 0; font-size: 10pt; color: var(--muted); }
.contact { list-style: none; padding: 0; margin: 2pt 0 0; width: 100%; display: flex; flex-wrap: wrap; gap: 0 10pt; font-size: 8.5pt; color: var(--muted); }

section { margin-top: 6pt; }
h2 { font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.8pt; margin: 0 0 3pt; border-bottom: 0.5pt solid var(--rule); }
h3 { font-size: 9.3pt; margin: 0; }
.org { font-weight: 400; }
.org::before { content: ", "; }
.dates, .entry-meta { font-size: 8.5pt; color: var(--muted); }
.entry { margin-bottom: 4pt; }
.entry-meta { margin: 0; }
ul { padding-left: 11pt; margin-top: 1pt; }
li { margin: 0.5pt 0; }
`;

export const STYLE_PRESETS: StylePreset[] = [
  { id: 'classic', name: 'Classic', description: 'Serif headings, centred header, navy accent.', css: CLASSIC },
  { id: 'modern', name: 'Modern', description: 'Sans-serif, left-aligned header, teal accent bars.', css: MODERN },
  { id: 'compact', name: 'Compact', description: 'Dense layout with small margins to save space.', css: COMPACT },
];

export const DEFAULT_STYLE = CLASSIC;

export function getPreset(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((p) => p.id === id);
}
