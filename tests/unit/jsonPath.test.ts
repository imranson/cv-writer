import { describe, expect, it } from 'vitest';
import { appendPath, deepMerge, formatPath, getPath, parsePath, removePath, searchJson, setPath } from '../../src/util/jsonPath';

const profile = {
  name: 'Ada',
  contact: { email: 'ada@example.com' },
  experience: [
    { title: 'Engineer', company: 'Acme', highlights: ['Built Python pipelines on AWS'] },
    { title: 'Analyst', company: 'Globex', highlights: ['Excel reporting'] },
  ],
  skills: ['Python', 'SQL'],
};

describe('parsePath / formatPath', () => {
  it('parses bracket and dot indices', () => {
    expect(parsePath('experience[1].highlights')).toEqual(['experience', 1, 'highlights']);
    expect(parsePath('experience.1.highlights')).toEqual(['experience', 1, 'highlights']);
    expect(parsePath('')).toEqual([]);
    expect(formatPath(['experience', 0, 'title'])).toBe('experience[0].title');
  });
  it('rejects prototype pollution segments', () => {
    expect(() => parsePath('__proto__.polluted')).toThrow(/Illegal/);
    expect(() => parsePath('a.constructor')).toThrow(/Illegal/);
  });
});

describe('getPath / setPath / appendPath / removePath', () => {
  it('reads nested values', () => {
    expect(getPath(profile, 'experience[1].company')).toBe('Globex');
    expect(getPath(profile, 'contact.missing.deep')).toBeUndefined();
    expect(getPath(profile, '')).toBe(profile);
  });
  it('sets without mutating and creates containers', () => {
    const next = setPath(profile, 'contact.phone', '123');
    expect(next.contact).toEqual({ email: 'ada@example.com', phone: '123' });
    expect(profile.contact).toEqual({ email: 'ada@example.com' });
    expect(setPath({}, 'a.list[0].x', 1)).toEqual({ a: { list: [{ x: 1 }] } });
  });
  it('appends to arrays, creating them if missing', () => {
    expect(appendPath(profile, 'skills', 'Go').skills).toEqual(['Python', 'SQL', 'Go']);
    expect(appendPath({}, 'projects', { name: 'X' })).toEqual({ projects: [{ name: 'X' }] });
    expect(() => appendPath(profile, 'name', 'x')).toThrow(/not an array/);
  });
  it('removes keys and array items', () => {
    expect(removePath(profile, 'skills[0]').skills).toEqual(['SQL']);
    expect(removePath(profile, 'contact.email').contact).toEqual({});
    expect(() => removePath(profile, 'nope')).toThrow(/Nothing at/);
    expect(() => removePath(profile, '')).toThrow(/root/);
  });
});

describe('deepMerge', () => {
  it('merges objects recursively and replaces arrays', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, l: [1] }, { a: { c: 3 }, l: [2] })).toEqual({ a: { b: 1, c: 3 }, l: [2] });
  });
  it('ignores __proto__ keys', () => {
    const merged: any = deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}}'));
    expect(({} as any).polluted).toBeUndefined();
    expect(merged.polluted).toBeUndefined();
  });
});

describe('searchJson', () => {
  it('matches every term against path or value, case-insensitively', () => {
    expect(searchJson(profile, 'python aws')).toEqual([{ path: 'experience[0].highlights[0]', value: 'Built Python pipelines on AWS' }]);
    expect(searchJson(profile, 'company').map((h) => h.value)).toEqual(['Acme', 'Globex']);
    expect(searchJson(profile, '   ')).toEqual([]);
  });
  it('honours the limit', () => {
    expect(searchJson({ list: Array(50).fill('x') }, 'x', 5)).toHaveLength(5);
  });
});
