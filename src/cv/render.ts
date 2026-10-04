import type { CvDocument, CvEntry, CvSection } from '../domain/schemas.js';

function renderEntryMarkdown(entry: CvEntry): string {
  let lead = `**${entry.heading}**`;
  if (entry.subheading) lead += `, ${entry.subheading}`;
  if (entry.dates) lead += ` · *${entry.dates}*`;
  return [lead, ...entry.bullets.map((b) => `- ${b}`)].join('\n');
}

function renderSectionMarkdown(section: CvSection): string {
  const blocks: string[] = [`## ${section.title}`];
  if (section.paragraph) blocks.push(section.paragraph);
  if (section.items.length) blocks.push(section.items.map((i) => `- ${i}`).join('\n'));
  for (const entry of section.entries) blocks.push(renderEntryMarkdown(entry));
  return blocks.join('\n\n');
}

export function renderMarkdown(doc: CvDocument): string {
  const blocks = [`# ${doc.name}`];
  if (doc.contactLine.length) blocks.push(doc.contactLine.join(' · '));
  for (const section of doc.sections) blocks.push(renderSectionMarkdown(section));
  return blocks.join('\n\n') + '\n';
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const SAFE_URL = /^(https?:|mailto:|tel:)/i;

/** Inline Markdown subset used in CVs: links, **bold**, *italic*. Input is escaped first. */
export function renderInline(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const href = SAFE_URL.test(url) ? url : `https://${url}`;
    return `<a href="${href}">${label}</a>`;
  });
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  return html;
}

const CSS = `
@page { size: A4; margin: 14mm 16mm; }
* { box-sizing: border-box; }
body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.38; color: #1a1a1a; max-width: 190mm; margin: 0 auto; padding: 12mm 0; }
h1 { font-size: 21pt; margin: 0 0 2pt; letter-spacing: 0.2pt; }
.contact { color: #444; margin: 0 0 8pt; }
h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.8pt; border-bottom: 1px solid #999; padding-bottom: 1.5pt; margin: 11pt 0 5pt; }
p { margin: 0 0 4pt; }
ul { margin: 2pt 0 6pt; padding-left: 14pt; }
li { margin: 0 0 1.5pt; }
.entry { break-inside: avoid; margin-bottom: 4pt; }
.entry-lead { margin: 0; }
.dates { color: #555; }
a { color: inherit; text-decoration: none; }
@media print { body { padding: 0; } }
`;

function renderEntryHtml(entry: CvEntry): string {
  let lead = `<strong>${renderInline(entry.heading)}</strong>`;
  if (entry.subheading) lead += `, ${renderInline(entry.subheading)}`;
  if (entry.dates) lead += ` · <em class="dates">${renderInline(entry.dates)}</em>`;
  const bullets = entry.bullets.length
    ? `<ul>${entry.bullets.map((b) => `<li>${renderInline(b)}</li>`).join('')}</ul>`
    : '';
  return `<div class="entry"><p class="entry-lead">${lead}</p>${bullets}</div>`;
}

function renderSectionHtml(section: CvSection): string {
  const parts = [`<h2>${renderInline(section.title)}</h2>`];
  if (section.paragraph) parts.push(`<p>${renderInline(section.paragraph)}</p>`);
  if (section.items.length) parts.push(`<ul>${section.items.map((i) => `<li>${renderInline(i)}</li>`).join('')}</ul>`);
  for (const entry of section.entries) parts.push(renderEntryHtml(entry));
  return `<section>${parts.join('')}</section>`;
}

export function renderHtml(doc: CvDocument): string {
  const contact = doc.contactLine.length
    ? `<p class="contact">${doc.contactLine.map(renderInline).join(' · ')}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.name)} — CV</title>
<style>${CSS}</style>
</head>
<body>
<header><h1>${renderInline(doc.name)}</h1>${contact}</header>
${doc.sections.map(renderSectionHtml).join('\n')}
</body>
</html>
`;
}

/** Plain text of the document (Markdown syntax stripped), for word counts and keyword checks. */
export function plainText(doc: CvDocument): string {
  return renderMarkdown(doc)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*#]/g, '')
    .replace(/^- /gm, '');
}
