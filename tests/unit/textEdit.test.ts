import { describe, expect, it } from 'vitest';
import { applyTextEdits } from '../../src/lib/textEdit.js';

describe('applyTextEdits', () => {
  it('replaces unique matches in order', () => {
    expect(applyTextEdits('<h1>Ada</h1><p>Dev</p>', [{ find: 'Ada', replace: 'Ada Lovelace' }, { find: 'Dev', replace: 'Lead' }])).toBe(
      '<h1>Ada Lovelace</h1><p>Lead</p>',
    );
  });
  it('treats replacement text literally (no $ patterns)', () => {
    expect(applyTextEdits('cost', [{ find: 'cost', replace: '$& $1 $$' }])).toBe('$& $1 $$');
  });
  it('requires uniqueness unless all=true', () => {
    expect(() => applyTextEdits('a a', [{ find: 'a', replace: 'b' }])).toThrow('occurs 2 times');
    expect(applyTextEdits('a a', [{ find: 'a', replace: 'b', all: true }])).toBe('b b');
  });
  it('reports missing and empty finds', () => {
    expect(() => applyTextEdits('abc', [{ find: 'x', replace: 'y' }])).toThrow('not found');
    expect(() => applyTextEdits('abc', [{ find: '', replace: 'y' }])).toThrow('must not be empty');
  });
});
