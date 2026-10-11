import { escapeHtml } from '../lib/html.js';

/**
 * Locks down rendered CVs: no scripts, no network. CV HTML is model-generated and may
 * echo text from fetched web pages, so it is treated as untrusted.
 */
export const CV_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** Strips an accidental full-document wrapper so only body content is embedded. */
export function extractBody(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return (body ? body[1] : html).trim();
}

export function renderCvDocument(html: string, css: string, title = 'CV'): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CV_CONTENT_SECURITY_POLICY}">
<title>${escapeHtml(title)}</title>
<style>
${css.replace(/<\/style/gi, '<\\/style')}
</style>
</head>
<body>
${extractBody(html)}
</body>
</html>
`;
}
