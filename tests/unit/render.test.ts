import { describe, expect, it } from 'vitest';
import { escapeHtml, plainText, renderHtml, renderInline, renderMarkdown } from '../../src/cv/render.js';
import { CvDocumentSchema } from '../../src/domain/schemas.js';
import { sampleCv } from '../helpers.js';

describe('renderMarkdown', () => {
  it('renders the header, sections, list items and entries', () => {
    const md = renderMarkdown(sampleCv());
    expect(md).toBe(`# Alex Morgan

Manchester, UK · alex.morgan@example.com · +44 7700 900123 · [github.com/alexmorgan](https://github.com/alexmorgan)

## Profile

Computer Science graduate building machine learning systems in Python on AWS.

## Experience

**Research Intern**, The University of Manchester · *June 2025 – Aug 2025*
- Generated synthetic clinical notes from 122,000+ medical records with differential privacy.
- Improved generation fidelity by up to 50% with custom quality filters.

## Education

**BSc Computer Science (First Class)**, The University of Manchester · *Sept 2023 – June 2026*

## Skills

- **Languages:** Python, TypeScript, SQL
- **Cloud:** AWS Lambda, S3
`);
  });

  it('omits optional parts that are absent', () => {
    const doc = CvDocumentSchema.parse({ name: 'A', sections: [{ title: 'Awards', entries: [{ heading: 'Prize' }] }] });
    expect(renderMarkdown(doc)).toBe('# A\n\n## Awards\n\n**Prize**\n');
  });
});

describe('renderInline', () => {
  it('converts bold, italic and links', () => {
    expect(renderInline('**Languages:** Python')).toBe('<strong>Languages:</strong> Python');
    expect(renderInline('a *b* c')).toBe('a <em>b</em> c');
    expect(renderInline('[site](https://x.dev)')).toBe('<a href="https://x.dev">site</a>');
  });

  it('adds a scheme to bare-domain links and neutralises script URLs', () => {
    expect(renderInline('[gh](github.com/a)')).toBe('<a href="https://github.com/a">gh</a>');
    expect(renderInline('[x](javascript:alert(1))')).not.toContain('href="javascript:');
  });

  it('escapes HTML before formatting', () => {
    expect(renderInline('<script>**x**</script>')).toBe('&lt;script&gt;<strong>x</strong>&lt;/script&gt;');
  });

  it('leaves multiplication-like asterisks alone', () => {
    expect(renderInline('2 * 3 = 6')).toBe('2 * 3 = 6');
  });
});

describe('renderHtml', () => {
  it('produces a standalone A4 print document', () => {
    const html = renderHtml(sampleCv());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('@page { size: A4');
    expect(html).toContain('<title>Alex Morgan — CV</title>');
    expect(html).toContain('<h2>Experience</h2>');
    expect(html).toContain('<strong>Research Intern</strong>, The University of Manchester');
    expect(html).toContain('<li><strong>Languages:</strong> Python, TypeScript, SQL</li>');
    expect(html).toContain('<a href="https://github.com/alexmorgan">github.com/alexmorgan</a>');
  });

  it('escapes the name in the title', () => {
    expect(renderHtml({ ...sampleCv(), name: 'A <B>' })).toContain('<title>A &lt;B&gt; — CV</title>');
  });
});

describe('plainText / escapeHtml', () => {
  it('strips markdown syntax', () => {
    const text = plainText(sampleCv());
    expect(text).not.toMatch(/[*#]/);
    expect(text).toContain('Languages: Python');
    expect(text).toContain('github.com/alexmorgan');
    expect(text).not.toContain('https://github.com');
  });

  it('escapes all special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
