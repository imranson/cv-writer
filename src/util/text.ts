export interface TextEdit {
  find: string;
  replace: string;
  /** Replace every occurrence instead of requiring a unique match. */
  all?: boolean;
}

/** Applies exact find/replace edits in order; throws if a `find` is missing or ambiguous. */
export function applyTextEdits(source: string, edits: TextEdit[]): string {
  let out = source;
  edits.forEach((edit, i) => {
    if (!edit.find) throw new Error(`Edit ${i + 1}: "find" must not be empty`);
    const count = out.split(edit.find).length - 1;
    if (count === 0) throw new Error(`Edit ${i + 1}: text not found: ${truncate(edit.find, 80)}`);
    if (count > 1 && !edit.all) {
      throw new Error(`Edit ${i + 1}: text occurs ${count} times; add more context or set all=true`);
    }
    out = edit.all ? out.split(edit.find).join(edit.replace) : out.replace(edit.find, () => edit.replace);
  });
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

/** Removes scripts, inline event handlers and javascript: URLs from agent-authored HTML. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<(iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

/** Very small HTML → text conversion for fetched web pages. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
