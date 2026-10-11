/** Starting stylesheet for every new CV. Users edit the raw CSS in the UI; the writer may too. */
export const DEFAULT_CV_CSS = `@page {
  size: A4;
  margin: 14mm 16mm;
}

:root {
  --accent: #1f4e79;
  --text: #1d1d1f;
  --muted: #5a5a60;
  --rule: #d6dbe1;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  color: var(--text);
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 10pt;
  line-height: 1.4;
}

.cv-header {
  border-bottom: 2px solid var(--accent);
  padding-bottom: 6pt;
  margin-bottom: 10pt;
}

.cv-header h1 {
  margin: 0;
  font-size: 22pt;
  letter-spacing: 0.5pt;
  color: var(--accent);
}

.cv-header .headline {
  margin: 2pt 0 4pt;
  font-size: 11.5pt;
  color: var(--muted);
}

.contact {
  display: flex;
  flex-wrap: wrap;
  gap: 2pt 12pt;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 9pt;
}

.cv-section { margin-bottom: 10pt; }

.cv-section h2 {
  margin: 0 0 5pt;
  padding-bottom: 2pt;
  border-bottom: 1px solid var(--rule);
  font-size: 11pt;
  text-transform: uppercase;
  letter-spacing: 1pt;
  color: var(--accent);
}

.entry {
  margin-bottom: 7pt;
  break-inside: avoid;
}

.entry-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8pt;
}

.entry-head h3 {
  margin: 0;
  font-size: 10.5pt;
}

.dates, .meta {
  color: var(--muted);
  font-size: 9pt;
  white-space: nowrap;
}

.meta { margin: 0 0 2pt; }

ul { margin: 2pt 0 0; padding-left: 14pt; }
li { margin-bottom: 1.5pt; }
p { margin: 0 0 4pt; }

.skills-list {
  display: flex;
  flex-wrap: wrap;
  gap: 3pt 6pt;
  padding: 0;
  list-style: none;
}

.skills-list li {
  padding: 1pt 6pt;
  border: 1px solid var(--rule);
  border-radius: 8pt;
  font-size: 9pt;
}

a { color: inherit; text-decoration: none; }
`;
