import type { CvDocument, CvItem, Style } from '../domain/schemas.js';
import { styleCss } from './style.js';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function linkHref(link: string): string | undefined {
  if (/^https?:\/\//i.test(link)) return link;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(link)) return `https://${link}`;
  return undefined;
}

function contactParts(doc: CvDocument): string[] {
  const parts: string[] = [];
  const { email, phone, location, links } = doc.contact;
  if (location) parts.push(`<span>${escapeHtml(location)}</span>`);
  if (phone) parts.push(`<span>${escapeHtml(phone)}</span>`);
  if (email) parts.push(`<span><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></span>`);
  for (const link of links) {
    const href = linkHref(link);
    const label = escapeHtml(link.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''));
    parts.push(href ? `<span><a href="${escapeHtml(href)}">${label}</a></span>` : `<span>${label}</span>`);
  }
  return parts;
}

function itemHtml(item: CvItem): string {
  const titleLine = [
    `<span class="cv-item-title">${escapeHtml(item.heading)}</span>`,
    item.subheading ? `<span class="cv-item-sub">, ${escapeHtml(item.subheading)}</span>` : '',
  ].join('');
  const meta = [item.location, item.dates].filter(Boolean).map((m) => escapeHtml(m!)).join(' · ');
  const bullets = item.bullets.length
    ? `<ul class="cv-bullets">${item.bullets.map((b) => `<li>${escapeHtml(b.text)}</li>`).join('')}</ul>`
    : '';
  return `<div class="cv-item"><div class="cv-item-head"><div>${titleLine}</div>${meta ? `<div class="cv-item-meta">${meta}</div>` : ''}</div>${
    item.summary ? `<p class="cv-item-summary">${escapeHtml(item.summary)}</p>` : ''
  }${bullets}</div>`;
}

/** The CV as a standalone, print-ready HTML page. The same page drives the preview and the PDF. */
export function renderHtml(doc: CvDocument, style: Style, title = `${doc.name} — CV`): string {
  const sections = doc.sections.map((s) => {
    let body: string;
    if (s.kind === 'entries') body = s.items.map(itemHtml).join('');
    else if (s.kind === 'skills')
      body = `<ul class="cv-skills">${s.groups
        .map((g) => `<li>${g.label ? `<b>${escapeHtml(g.label)}:</b> ` : ''}${g.items.map(escapeHtml).join(', ')}</li>`)
        .join('')}</ul>`;
    else body = `<p class="cv-text">${escapeHtml(s.text)}</p>`;
    return `<section class="cv-section"><h2>${escapeHtml(s.title)}</h2>${body}</section>`;
  });
  const contact = contactParts(doc);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${styleCss(style)}</style>
</head>
<body>
<main class="page">
<header class="cv-header">
<h1 class="cv-name">${escapeHtml(doc.name)}</h1>
${doc.headline ? `<p class="cv-headline">${escapeHtml(doc.headline)}</p>` : ''}
${contact.length ? `<p class="cv-contact">${contact.join('')}</p>` : ''}
</header>
${doc.summary ? `<section class="cv-section"><h2>Profile</h2><p class="cv-summary">${escapeHtml(doc.summary)}</p></section>` : ''}
${sections.join('\n')}
</main>
</body>
</html>
`;
}

/** Plain Markdown, handy for pasting into application forms. */
export function renderMarkdown(doc: CvDocument): string {
  const lines: string[] = [`# ${doc.name}`];
  if (doc.headline) lines.push('', doc.headline);
  const { email, phone, location, links } = doc.contact;
  const contact = [location, phone, email, ...links].filter(Boolean);
  if (contact.length) lines.push('', contact.join(' · '));
  if (doc.summary) lines.push('', '## Profile', '', doc.summary);
  for (const s of doc.sections) {
    lines.push('', `## ${s.title}`);
    if (s.kind === 'entries') {
      for (const item of s.items) {
        const meta = [item.location, item.dates].filter(Boolean).join(' · ');
        lines.push('', `**${item.heading}**${item.subheading ? `, *${item.subheading}*` : ''}${meta ? ` — ${meta}` : ''}`);
        if (item.summary) lines.push('', item.summary);
        if (item.bullets.length) lines.push('', ...item.bullets.map((b) => `- ${b.text}`));
      }
    } else if (s.kind === 'skills') {
      lines.push('', ...s.groups.map((g) => `- ${g.label ? `**${g.label}:** ` : ''}${g.items.join(', ')}`));
    } else {
      lines.push('', s.text);
    }
  }
  return `${lines.join('\n')}\n`;
}
