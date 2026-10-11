import { describe, expect, it } from 'vitest';
import { applyJsonOps, getAtPath, parsePath } from '../../src/lib/jsonOps.js';

describe('parsePath', () => {
  it('handles dots and brackets', () => {
    expect(parsePath('experience[0].highlights')).toEqual(['experience', '0', 'highlights']);
    expect(parsePath('')).toEqual([]);
  });
  it('rejects prototype pollution', () => {
    expect(() => parsePath('__proto__.x')).toThrow('Forbidden');
    expect(() => parsePath('a.constructor')).toThrow('Forbidden');
  });
});

describe('applyJsonOps', () => {
  const doc = { name: 'Ada', contact: { email: 'a@x.com' }, skills: ['Maths'], experience: [{ title: 'Dev' }] };

  it('sets nested values, creating containers', () => {
    const out = applyJsonOps(doc, [
      { op: 'set', path: 'contact.phone', value: '123' },
      { op: 'set', path: 'experience.0.title', value: 'Lead' },
      { op: 'set', path: 'links.0', value: 'https://a.dev' },
    ]);
    expect(out.contact).toEqual({ email: 'a@x.com', phone: '123' });
    expect(out.experience[0].title).toBe('Lead');
    expect((out as Record<string, unknown>).links).toEqual(['https://a.dev']);
  });

  it('appends, deletes and merges', () => {
    const out = applyJsonOps(doc, [
      { op: 'append', path: 'skills', value: 'TypeScript' },
      { op: 'append', path: 'languages', value: 'French' },
      { op: 'delete', path: 'skills.0' },
      { op: 'merge', path: 'contact', value: { location: 'London' } },
      { op: 'merge', path: '', value: { headline: 'Programmer' } },
    ]);
    expect(out.skills).toEqual(['TypeScript']);
    expect((out as Record<string, unknown>).languages).toEqual(['French']);
    expect(out.contact).toEqual({ email: 'a@x.com', location: 'London' });
    expect((out as Record<string, unknown>).headline).toBe('Programmer');
  });

  it('is all-or-nothing and never mutates the input', () => {
    expect(() =>
      applyJsonOps(doc, [
        { op: 'set', path: 'name', value: 'Changed' },
        { op: 'append', path: 'name', value: 'x' },
      ]),
    ).toThrow('Operation 2 (append "name") failed: Cannot append');
    expect(doc.name).toBe('Ada');
  });

  it('reports bad targets', () => {
    expect(() => applyJsonOps(doc, [{ op: 'delete', path: 'missing' }])).toThrow('Nothing to delete');
    expect(() => applyJsonOps(doc, [{ op: 'set', path: 'experience.5', value: 1 }])).toThrow('out of range');
    expect(() => applyJsonOps(doc, [{ op: 'set', path: 'name.first', value: 1 }])).toThrow('Cannot descend');
    expect(() => applyJsonOps(doc, [{ op: 'merge', path: 'skills', value: { a: 1 } }])).toThrow('not an object');
    expect(() => applyJsonOps(doc, [{ op: 'merge', path: '', value: JSON.parse('{"__proto__": {"x": 1}}') }])).toThrow('Forbidden');
  });

  it('reads paths', () => {
    expect(getAtPath(doc, 'experience[0].title')).toBe('Dev');
    expect(getAtPath(doc, 'nope.deeper')).toBeUndefined();
  });
});
