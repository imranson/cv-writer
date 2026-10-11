const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|noscript|template|title|head|svg|math)\b[\s\S]*?<\/\1\s*>/gi;
const DROP_TAG = /<\/?(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|frame|frameset|html|body|main|!doctype)\b[^>]*>/gi;
const EVENT_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const STYLE_ATTR = /\s+style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const BAD_URL_ATTR = /\s(href|src|xlink:href|action|formaction)\s*=\s*("|')?\s*(?:javascript|vbscript|data):[^"'\s>]*\2?/gi;

/** Removes a surrounding ```html fence that models sometimes add. */
export function stripCodeFence(text: string): string {
  const m = text.trim().match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
  return m?.[1] ?? text;
}

/**
 * Normalises model- or user-supplied CV markup to a safe body fragment:
 * no scripts, embedded styles (styling lives in the per-CV stylesheet), event handlers or script URLs.
 */
export function sanitizeCvHtml(input: string): string {
  let s = stripCodeFence(input).trim();
  const body = s.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  if (body?.[1] !== undefined) s = body[1];
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(DROP_WITH_CONTENT, '');
  s = s.replace(DROP_TAG, '');
  s = s.replace(EVENT_ATTR, '');
  s = s.replace(STYLE_ATTR, '');
  s = s.replace(BAD_URL_ATTR, ' $1="#"');
  return s.trim();
}

/** Prevents CSS from closing the surrounding <style> element. */
export function sanitizeCss(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style').replace(/<!--|-->/g, '');
}
