/** Minimal, safe Markdown → HTML (escapes all raw HTML). Used for chat answers and agent text. */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function inline(text: string): string {
  const codes: string[] = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|\/)[^\s)]+)\)/g, (_m, label: string, url: string) =>
      `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const level = Math.min(heading[1].length + 2, 6); // keep headings small inside chat
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          item += ` ${lines[i].trim()}`;
          i++;
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}
