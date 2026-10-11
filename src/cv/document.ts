// Pure module (no Node APIs): also bundled into the web client for live CSS previews.
import { sanitizeCss, sanitizeCvHtml } from './sanitize.ts';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface PageBox {
  width: string;
  height: string;
  margin: string;
}

const PAGE_SIZES: Record<string, [string, string]> = {
  a4: ['210mm', '297mm'],
  a5: ['148mm', '210mm'],
  letter: ['8.5in', '11in'],
  legal: ['8.5in', '14in'],
};

/** Reads size and margin from the stylesheet's @page rule (used to mimic paper in the on-screen preview). */
export function parsePageBox(css: string): PageBox {
  const box: PageBox = { width: '210mm', height: '297mm', margin: '15mm' };
  const page = css.match(/@page\s*\{([^}]*)\}/i)?.[1];
  if (!page) return box;
  const size = page.match(/(?:^|[;\s])size\s*:\s*([^;]+)/i)?.[1]?.trim().toLowerCase();
  if (size) {
    const [first, second] = size.split(/\s+/);
    const named = first ? PAGE_SIZES[first] : undefined;
    if (named) {
      const landscape = second === 'landscape';
      box.width = landscape ? named[1] : named[0];
      box.height = landscape ? named[0] : named[1];
    } else if (first && second && /\d/.test(first) && /\d/.test(second)) {
      box.width = first;
      box.height = second;
    }
  }
  const margin = page.match(/(?:^|[;\s])margin\s*:\s*([^;]+)/i)?.[1]?.trim();
  if (margin) box.margin = margin;
  return box;
}

/** Screen-only rules that render the CV as a sheet of paper; ignored when printing to PDF. */
export function previewCss(css: string): string {
  const box = parsePageBox(css);
  return `@media screen {
  html { background: #e7e9ee; }
  body { width: ${box.width}; min-height: ${box.height}; padding: ${box.margin}; margin: 24px auto;
         background: #fff; box-shadow: 0 2px 12px rgba(15, 23, 42, 0.18); }
}`;
}

export interface CvDocumentOptions {
  html: string;
  css: string;
  title?: string;
  /** Adds paper-like screen styling for the in-app preview. */
  preview?: boolean;
}

export function buildCvDocument({ html, css, title = 'CV', preview = false }: CvDocumentOptions): string {
  const extra = preview ? `\n<style>${previewCss(css)}</style>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${sanitizeCss(css)}</style>${extra}
</head>
<body>
<main class="cv">
${sanitizeCvHtml(html)}
</main>
</body>
</html>
`;
}
