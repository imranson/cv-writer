import { describe, expect, it } from 'vitest';
import { applyOps, applyTextEdits, formatPath, getAt, parsePath, searchJson } from '../../src/lib/jsonOps.js';

const profile = {
  name: 'Ann',
  contact: { email: 'ann@example.com' },
  experience: [
    { title: 'Engineer', company: 'Acme', highlights: ['Built Python ETL', 'Mentored 2 juniors'] },
    { title: 'Analyst', company: 'Globex', highlights: ['SQL dashboards'] },
  ],
};

describe('paths', () => {
  it('parses dot, bracket and quoted segments', () => {
    expect(parsePath('experience[0].highlights[1]')).toEqual(['experience', 0, 'highlights', 1]);
    expect(parsePath('experience.1.title')).toEqual(['experience', 1, 'title']);
    expect(parsePath('a["b c"]')).toEqual(['a', 'b c']);
    expect(parsePath('')).toEqual([]);
    expect(parsePath('$.name')).toEqual(['name']);
    expect(() => parsePath('a[b')).toThrow('Invalid path');
  });

  it('formats paths back', () => {
    expect(formatPath(['experience', 0, 'title'])).toBe('experience[0].title');
    expect(formatPath(['a', 'b c'])).toBe('a["b c"]');
  });

  it('reads values', () => {
    expect(getAt(profile, 'experience[1].company')).toBe('Globex');
    expect(getAt(profile, 'missing.path')).toBeUndefined();
    expect(getAt(profile, '')).toBe(profile);
  });
});

describe('applyOps (editX "update" mode)', () => {
  it('sets, merges, appends and removes without mutating the input', () => {
    const out = applyOps(profile, [
      { op: 'set', path: 'contact.phone', value: '+44 1' },
      { op: 'merge', path: 'experience[0]', value: { location: 'Leeds' } },
      { op: 'append', path: 'experience[1].highlights', value: 'Cut costs 10%' },
      { op: 'append', path: 'skills', value: 'Python' },
      { op: 'remove', path: 'experience[0].highlights[1]' },
      { op: 'set', path: 'education[0].institution', value: 'Leeds' },
    ]);
    expect(out.contact).toEqual({ email: 'ann@example.com', phone: '+44 1' });
    expect(out.experience[0]).toMatchObject({ location: 'Leeds', highlights: ['Built Python ETL'] });
    expect(out.experience[1].highlights).toEqual(['SQL dashboards', 'Cut costs 10%']);
    expect((out as any).skills).toEqual(['Python']);
    expect((out as any).education).toEqual([{ institution: 'Leeds' }]);
    expect(profile.experience[0].highlights).toHaveLength(2);
    expect('phone' in profile.contact).toBe(false);
  });

  it('supports root set/merge and reports bad operations', () => {
    expect(applyOps({ a: 1 }, [{ op: 'merge', path: '', value: { b: 2 } }])).toEqual({ a: 1, b: 2 });
    expect(applyOps({ a: 1 }, [{ op: 'set', path: '', value: { c: 3 } }])).toEqual({ c: 3 });
    expect(() => applyOps({ a: 1 }, [{ op: 'append', path: 'a', value: 2 }])).toThrow('not an array');
    expect(() => applyOps({ a: 1 }, [{ op: 'remove', path: 'nope' }])).toThrow('Path not found');
    expect(() => applyOps({ a: 1 }, [{ op: 'remove', path: '' }])).toThrow('non-empty path');
  });
});

describe('searchJson (readProfile "search" mode)', () => {
  it('matches all terms across path and value, case-insensitively', () => {
    expect(searchJson(profile, 'python')).toEqual([{ path: 'experience[0].highlights[0]', value: 'Built Python ETL' }]);
    expect(searchJson(profile, 'company acme')).toEqual([{ path: 'experience[0].company', value: 'Acme' }]);
    expect(searchJson(profile, 'nothing-here')).toEqual([]);
    expect(searchJson(profile, '   ')).toEqual([]);
    expect(searchJson(profile, 'e', 2)).toHaveLength(2);
  });
});

describe('applyTextEdits (editCV/editCSS "update" mode)', () => {
  it('replaces unique matches and guards ambiguity', () => {
    expect(applyTextEdits('<li>a</li><li>b</li>', [{ find: '<li>b</li>', replace: '<li>c</li>' }])).toBe('<li>a</li><li>c</li>');
    expect(() => applyTextEdits('x x', [{ find: 'x', replace: 'y' }])).toThrow('occurs 2 times');
    expect(applyTextEdits('x x', [{ find: 'x', replace: 'y', all: true }])).toBe('y y');
    expect(() => applyTextEdits('abc', [{ find: 'z', replace: 'y' }])).toThrow('not found');
    expect(applyTextEdits('cost', [{ find: 'cost', replace: '$& $1' }])).toBe('$& $1');
  });
});
