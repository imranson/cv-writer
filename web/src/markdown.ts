export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isDivider = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * A small, safe Markdown subset for chat replies: paragraphs, headings, bullet and numbered lists,
 * tables, bold, italic, inline code and links. Everything is escaped first, so model output cannot
 * inject HTML.
 */
export function renderMarkdown(source: string): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | undefined;
  let para: string[] = [];
  let table: string[][] = [];
  const flushTable = () => {
    if (!table.length) return;
    const [head, ...rows] = table;
    out.push(
      `<table><thead><tr>${head!.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`,
    );
    table = [];
  };
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = undefined;
  };
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isTableRow(line) && (table.length || isDivider(lines[i + 1] ?? ''))) {
      flushPara();
      closeList();
      if (!isDivider(line)) table.push(cells(line));
      if (isDivider(lines[i + 1] ?? '')) i++;
      continue;
    }
    flushTable();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1]!)}</li>`);
    } else if (heading) {
      flushPara();
      closeList();
      out.push(`<h4>${inline(heading[2]!)}</h4>`);
    } else if (!line.trim()) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushTable();
  flushPara();
  closeList();
  return out.join('');
}
