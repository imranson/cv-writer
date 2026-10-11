import { describe, expect, it } from 'vitest';
import { DEFAULT_CV_CSS } from '../../src/cv/defaultStyle.js';
import { CV_CONTENT_SECURITY_POLICY, extractBody, renderCvDocument } from '../../src/cv/render.js';

describe('CV document rendering', () => {
  it('combines body HTML and CSS into a locked-down document', () => {
    const doc = renderCvDocument('<h1>Ada</h1>', 'h1 { color: red; }', 'CV – Ada <Lovelace>');
    expect(doc).toMatch(/^<!doctype html>/);
    expect(doc).toContain('<style>\nh1 { color: red; }\n</style>');
    expect(doc).toContain('<body>\n<h1>Ada</h1>\n</body>');
    expect(doc).toContain(`content="${CV_CONTENT_SECURITY_POLICY}"`);
    expect(doc).toContain('<title>CV – Ada &lt;Lovelace&gt;</title>');
    expect(CV_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
  });

  it('unwraps accidental full documents and cannot break out of the style element', () => {
    expect(extractBody('<html><head></head><body class="x"><p>Hi</p></body></html>')).toBe('<p>Hi</p>');
    expect(renderCvDocument('<p>x</p>', 'a{}</style><script>alert(1)</script>')).not.toContain('</style><script>');
  });

  it('ships a print-ready default stylesheet', () => {
    expect(DEFAULT_CV_CSS).toContain('@page');
    for (const cls of ['.cv-header', '.cv-section', '.entry', '.entry-head', '.dates', '.skills-list']) expect(DEFAULT_CV_CSS).toContain(cls);
  });
});
