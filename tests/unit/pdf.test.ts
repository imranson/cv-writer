import { describe, expect, it } from 'vitest';
import { buildCvDocument, countPdfPages } from '../../src/pdf';

describe('buildCvDocument', () => {
  it('wraps body HTML and CSS in a standalone document with a CSP', () => {
    const doc = buildCvDocument('<h1>Ada</h1>', 'h1{color:red}', { title: 'CV <Acme>', lang: 'en-GB' });
    expect(doc).toMatch(/^<!doctype html>/);
    expect(doc).toContain('<html lang="en">');
    expect(doc).toContain('<title>CV &lt;Acme&gt;</title>');
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain('h1{color:red}');
    expect(doc).toContain('<body>\n<h1>Ada</h1>');
  });

  it('prevents CSS from closing the style element', () => {
    const doc = buildCvDocument('', 'x{}</style><script>alert(1)</script>');
    expect(doc).not.toContain('</style><script>');
  });
});

describe('countPdfPages', () => {
  it('counts /Type /Page objects but not /Pages', () => {
    const fake = Buffer.from('<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page >>', 'latin1');
    expect(countPdfPages(fake)).toBe(2);
  });
});
