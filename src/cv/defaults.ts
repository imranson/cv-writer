export const DEFAULT_PREFERENCES = {
  language: 'en-GB',
  paperSize: 'A4',
  maxPages: 2,
  tone: 'professional',
  sectionOrder: ['summary', 'experience', 'skills', 'education', 'certifications', 'projects'],
  emphasise: [] as string[],
  exclude: [] as string[],
  includePhoto: false,
  notes: '',
};

export type PaperSize = 'A4' | 'Letter';

export function paperSizeOf(preferences: Record<string, unknown>): PaperSize {
  return String(preferences.paperSize ?? '').toLowerCase() === 'letter' ? 'Letter' : 'A4';
}

export const DEFAULT_CSS = `/* CV stylesheet — edited by the Writer agent or by you. */
@page {
  size: A4;
  margin: 14mm 15mm;
}

:root {
  --ink: #1d2433;
  --muted: #5b6475;
  --accent: #1f5f8b;
  --rule: #d5dbe3;
}

* { box-sizing: border-box; }

html { background: #fff; }

body {
  margin: 0 auto;
  max-width: 190mm;
  color: var(--ink);
  font-family: "Helvetica Neue", Arial, "Liberation Sans", sans-serif;
  font-size: 10pt;
  line-height: 1.38;
}

header.cv-header { margin-bottom: 10pt; }

h1 {
  margin: 0;
  font-size: 21pt;
  letter-spacing: 0.2pt;
  font-weight: 700;
}

.cv-headline {
  margin: 2pt 0 4pt;
  color: var(--accent);
  font-size: 11.5pt;
  font-weight: 600;
}

.cv-contact {
  display: flex;
  flex-wrap: wrap;
  gap: 2pt 12pt;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--muted);
  font-size: 9pt;
}

.cv-contact a { color: inherit; text-decoration: none; }

section { margin-top: 10pt; }

h2 {
  margin: 0 0 5pt;
  padding-bottom: 2pt;
  border-bottom: 1px solid var(--rule);
  color: var(--accent);
  font-size: 10.5pt;
  letter-spacing: 1pt;
  text-transform: uppercase;
}

.cv-entry { margin-bottom: 7pt; break-inside: avoid; }

.cv-entry-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8pt;
}

h3 { margin: 0; font-size: 10.5pt; }

.cv-org { font-weight: 600; }

.cv-dates, .cv-location { color: var(--muted); font-size: 9pt; white-space: nowrap; }

ul { margin: 3pt 0 0; padding-left: 13pt; }

li { margin-bottom: 1.5pt; }

p { margin: 0 0 4pt; }

.cv-skills { display: grid; grid-template-columns: max-content 1fr; gap: 2pt 10pt; }

.cv-skills dt { font-weight: 600; }

.cv-skills dd { margin: 0; }

.cv-empty { color: var(--muted); font-style: italic; }

@media screen {
  body { padding: 14mm 15mm; }
}
`;
