import { describe, expect, it } from 'vitest';
import { parseFrontmatter, stringifyFrontmatter } from '../../src/util/frontmatter.ts';
import { assertValidId, isValidId, makeId, slugify } from '../../src/util/ids.ts';
import { decodeEntities, hashText, htmlToText, stripTags, truncate, wordCount } from '../../src/util/text.ts';

describe('ids', () => {
  it('slugifies text, including accents', () => {
    expect(slugify('Senior Data Analyst — Café Ltd!')).toBe('senior-data-analyst-cafe-ltd');
    expect(slugify('   ')).toBe('');
  });

  it('makes readable unique ids that pass validation', () => {
    const a = makeId('Acme', 'Data Engineer');
    const b = makeId('Acme', 'Data Engineer');
    expect(a).toMatch(/^acme-data-engineer-[a-z0-9]{6}$/);
    expect(a).not.toBe(b);
    expect(isValidId(a)).toBe(true);
    expect(isValidId(makeId())).toBe(true);
  });

  it('rejects ids that could escape the data directory', () => {
    for (const bad of ['../etc', 'a/b', '', 'UPPER', '.hidden', 'a'.repeat(81)]) expect(isValidId(bad)).toBe(false);
    expect(() => assertValidId('../x', 'job id')).toThrow(/Invalid job id/);
  });
});

describe('text', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('A &amp; B &ndash; &#163;5 &#x2014; &unknown;')).toBe('A & B – £5 — &unknown;');
  });

  it('converts HTML to readable text with headings and bullets', () => {
    const text = htmlToText('<h1>Jane</h1><script>x()</script><section><h2>Experience</h2><ul><li>Did <b>this</b></li><li>And that</li></ul></section>');
    expect(text).toBe('# Jane\n\n## Experience\n\n- Did this\n- And that');
  });

  it('strips tags, counts words, truncates and hashes', () => {
    expect(stripTags('<p>Hello <em>world</em></p>')).toBe('Hello world');
    expect(wordCount('  one two\nthree ')).toBe(3);
    expect(wordCount('')).toBe(0);
    expect(truncate('abcdef', 3)).toMatch(/^abc\n…\[truncated 3 characters\]$/);
    expect(hashText('x')).toHaveLength(16);
    expect(hashText('x')).toBe(hashText('x'));
  });
});

describe('frontmatter', () => {
  it('parses scalars, inline lists and block lists', () => {
    const { data, body } = parseFrontmatter('---\nname: My skill\ncount: 3\nflag: true\ntags: [a, "b c"]\naudience:\n  - writer\n  - critic\n---\n\n# Body\n');
    expect(data).toEqual({ name: 'My skill', count: 3, flag: true, tags: ['a', 'b c'], audience: ['writer', 'critic'] });
    expect(body).toBe('# Body\n');
  });

  it('returns the whole text as body when there is no frontmatter', () => {
    expect(parseFrontmatter('just text')).toEqual({ data: {}, body: 'just text' });
  });

  it('round-trips through stringify, quoting risky values', () => {
    const text = stringifyFrontmatter({ name: 'Rule: one', description: 'true', tags: ['x', 'y'], autoload: false, skip: undefined }, 'Body text');
    const parsed = parseFrontmatter(text);
    expect(parsed.data).toEqual({ name: 'Rule: one', description: 'true', tags: ['x', 'y'], autoload: false });
    expect(parsed.body.trim()).toBe('Body text');
  });
});
