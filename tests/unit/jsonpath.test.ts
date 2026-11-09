import { describe, expect, it } from 'vitest';
import { APPEND, deleteAt, getAt, mergePatch, outline, parsePath, searchJson, setAt } from '../../src/lib/jsonpath.js';

const doc = {
  basics: { name: 'Ada Lovelace', email: 'ada@example.com', links: [{ url: 'https://ada.dev' }] },
  experience: [
    { company: 'Analytical Engines', title: 'Engineer', highlights: ['Wrote the first algorithm', 'Python tooling'] },
    { company: 'Babbage & Co', title: 'Analyst', highlights: [] },
  ],
  skills: ['Python', 'AWS'],
};

describe('parsePath', () => {
  it('parses dotted, bracket and append forms', () => {
    expect(parsePath('experience[0].title')).toEqual(['experience', 0, 'title']);
    expect(parsePath('basics.links.0.url')).toEqual(['basics', 'links', 0, 'url']);
    expect(parsePath('skills[]')).toEqual(['skills', APPEND]);
    expect(parsePath('$.basics.name')).toEqual(['basics', 'name']);
    expect(parsePath('')).toEqual([]);
  });
  it('rejects malformed paths', () => {
    expect(() => parsePath('a..b')).toThrow(/Invalid path/);
    expect(() => parsePath('a[x]')).toThrow(/Invalid path/);
  });
});

describe('getAt / setAt / deleteAt', () => {
  it('reads nested values', () => {
    expect(getAt(doc, 'experience[1].company')).toBe('Babbage & Co');
    expect(getAt(doc, 'basics.links[0].url')).toBe('https://ada.dev');
    expect(getAt(doc, 'experience[5].company')).toBeUndefined();
    expect(getAt(doc, 'basics.name.first')).toBeUndefined();
  });

  it('sets values immutably and creates containers', () => {
    const next = setAt(doc, 'experience[0].title', 'Lead Engineer');
    expect(next.experience[0].title).toBe('Lead Engineer');
    expect(doc.experience[0].title).toBe('Engineer');
    const appended = setAt(doc, 'skills[]', 'Rust');
    expect(appended.skills).toEqual(['Python', 'AWS', 'Rust']);
    const created = setAt({}, 'education[0].institution', 'Cambridge') as any;
    expect(created).toEqual({ education: [{ institution: 'Cambridge' }] });
    expect(setAt(doc, '', { a: 1 })).toEqual({ a: 1 });
  });

  it('rejects out-of-range indexes and invalid parents', () => {
    expect(() => setAt(doc, 'skills[7]', 'x')).toThrow(/out of range/);
    expect(() => setAt(doc, 'basics.name.first', 'x')).toThrow(/parent is not an object/);
    expect(() => setAt(doc, 'basics[]', 'x')).toThrow(/Cannot append/);
  });

  it('deletes keys and splices array items', () => {
    const [a, removedA] = deleteAt(doc, 'basics.email');
    expect(removedA).toBe(true);
    expect('email' in (a as any).basics).toBe(false);
    const [b, removedB] = deleteAt(doc, 'experience[0]');
    expect(removedB).toBe(true);
    expect((b as any).experience).toHaveLength(1);
    expect(deleteAt(doc, 'nope.nothing')[1]).toBe(false);
    expect(() => deleteAt(doc, '')).toThrow(/root/);
  });
});

describe('mergePatch (RFC 7386)', () => {
  it('merges objects, replaces arrays, deletes with null', () => {
    const out = mergePatch(doc, { basics: { email: null, phone: '123' }, skills: ['Go'] });
    expect(out.basics).toEqual({ name: 'Ada Lovelace', phone: '123', links: [{ url: 'https://ada.dev' }] });
    expect(out.skills).toEqual(['Go']);
    expect(doc.basics.email).toBe('ada@example.com');
  });
  it('replaces non-object targets', () => {
    expect(mergePatch('x', { a: 1 })).toEqual({ a: 1 });
    expect(mergePatch({ a: 1 }, 'y')).toBe('y');
  });
});

describe('searchJson', () => {
  it('finds leaves by keyword in path or value, best first', () => {
    const hits = searchJson(doc, 'python engineer');
    expect(hits[0].score).toBeGreaterThanOrEqual(1);
    const paths = hits.map((h) => h.path);
    expect(paths).toContain('skills[0]');
    expect(paths).toContain('experience[0].title');
    expect(paths).toContain('experience[0].highlights[1]');
  });
  it('matches keys too and handles empty queries', () => {
    expect(searchJson(doc, 'email').map((h) => h.path)).toEqual(['basics.email']);
    expect(searchJson(doc, '   ')).toEqual([]);
  });
});

describe('outline', () => {
  it('summarises top-level keys', () => {
    expect(outline(doc)).toEqual({
      basics: 'object{name, email, links}',
      experience: 'array(2)',
      skills: 'array(2)',
    });
  });
});
