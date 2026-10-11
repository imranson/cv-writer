// Small, safe Markdown renderer for chat messages, profiles and skills.
// All text is HTML-escaped before any markup is added, so model output cannot inject HTML.

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^\/(?!\/)/.test(u) || u.startsWith('#')) return u;
  return null;
}

function link(text: string, rawUrl: string): string {
  // rawUrl is already HTML-escaped; unescape &amp; for the check, then re-escape.
  const url = safeUrl(rawUrl.replace(/&amp;/g, '&'));
  if (!url) return text;
  const external = /^https?:/i.test(url);
  return `<a href="${escapeHtml(url)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
}

export function renderInline(text: string): string {
  const codes: string[] = [];
  let s = escapeHtml(text).replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => link(label, url));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_m, pre: string, url: string) => `${pre}${link(url, url)}`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function renderList(lines: string[]): string {
  const first = lines[0]?.match(LIST_ITEM);
  const ordered = Boolean(first && /\d/.test(first[2] ?? ''));
  const baseIndent = first?.[1]?.length ?? 0;
  const items: string[][] = [];
  for (const line of lines) {
    const m = line.match(LIST_ITEM);
    if (m && (m[1]?.length ?? 0) <= baseIndent + 1) items.push([m[3] ?? '']);
    else items.at(-1)?.push(line);
  }
  const html = items
    .map(([head, ...rest]) => {
      const nested = rest.filter((l) => l.trim());
      const sub = nested.length && LIST_ITEM.test(nested[0] ?? '') ? renderList(nested) : nested.length ? `<br>${renderInline(nested.join(' ').trim())}` : '';
      const task = head?.match(/^\[( |x)\]\s+(.*)$/i);
      const content = task ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${renderInline(task[2] ?? '')}` : renderInline(head ?? '');
      return `<li>${content}${sub}</li>`;
    })
    .join('');
  return ordered ? `<ol>${html}</ol>` : `<ul>${html}</ul>`;
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)\s*([\w-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(fence[1] ?? '```')) body.push(lines[i++] ?? '');
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) quote.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) rows.push(splitRow(lines[i++] ?? ''));
      out.push(
        `<table><thead><tr>${header.map((h) => `<th>${renderInline(h)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${header.map((_h, c) => `<td>${renderInline(r[c] ?? '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const block: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (!l.trim()) {
          // A blank line ends the list unless the next line continues it.
          const next = lines[i + 1] ?? '';
          if (LIST_ITEM.test(next) || /^\s{2,}\S/.test(next)) {
            i++;
            continue;
          }
          break;
        }
        if (!LIST_ITEM.test(l) && !/^\s+\S/.test(l) && block.length) break;
        block.push(l);
        i++;
      }
      out.push(renderList(block));
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (!l.trim() || /^(#{1,6})\s/.test(l) || /^\s*(```|~~~)/.test(l) || /^\s*>/.test(l) || LIST_ITEM.test(l)) break;
      para.push(l);
      i++;
    }
    out.push(`<p>${para.map((p) => renderInline(p.trim())).join('<br>')}</p>`);
  }
  return out.join('\n');
}
