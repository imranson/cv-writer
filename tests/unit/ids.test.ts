import { describe, expect, it } from 'vitest';
import { assertValidId, isValidId, newId, slugify } from '../../src/lib/ids.js';

describe('ids', () => {
  it('accepts safe ids and rejects traversal', () => {
    expect(isValidId('job-acme-1a2b3c')).toBe(true);
    for (const bad of ['../etc/passwd', 'a/b', '', 'UPPER', '-lead', 'a'.repeat(81), 'x.json', null, 42]) {
      expect(isValidId(bad)).toBe(false);
    }
    expect(() => assertValidId('../x', 'jobId')).toThrow('Invalid jobId');
  });
  it('builds readable unique ids', () => {
    expect(slugify('Senior Engineer @ Café Ünïcode!')).toBe('senior-engineer-cafe-unicode');
    const id = newId('job', 'Senior Engineer Acme');
    expect(id).toMatch(/^job-senior-engineer-acme-[0-9a-f]{6}$/);
    expect(isValidId(id)).toBe(true);
    expect(newId('chat')).toMatch(/^chat-[0-9a-f]{6}$/);
    expect(newId('x', 'a')).not.toBe(newId('x', 'a'));
  });
});
