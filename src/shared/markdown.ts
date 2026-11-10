/** Safe GFM Markdown → HTML for chat answers and agent text. Raw HTML is escaped, only http(s)/mailto/relative links survive. */
import { Marked, type Tokens } from 'marked';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SAFE_URL = /^(?:https?:\/\/|mailto:|\/)/i;

function safeHref(href: string): string | null {
  const url = href.trim();
  if (!SAFE_URL.test(url)) return null;
  try {
    return esc(encodeURI(decodeURI(url)));
  } catch {
    return esc(url);
  }
}

const md = new Marked({
  gfm: true,
  breaks: true, // models use single newlines as line breaks
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      const text = esc(token.text);
      return 'block' in token && token.block ? `<p>${text.trim().replace(/\n/g, '<br>')}</p>\n` : text;
    },
    heading({ tokens, depth }: Tokens.Heading) {
      const level = Math.min(depth + 2, 6); // keep headings small inside chat
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    link({ href, title, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens);
      const url = safeHref(href);
      if (!url) return label;
      const t = title ? ` title="${esc(title)}"` : '';
      return `<a href="${url}"${t} target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      const url = safeHref(href);
      return url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${esc(text || href)}</a>` : esc(text);
    },
  },
});

export function renderMarkdown(src: string): string {
  return (md.parse(src.replace(/\r\n/g, '\n'), { async: false }) as string).trim();
}
