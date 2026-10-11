import { describe, expect, it } from 'vitest';
import { rankDocuments, tokenize } from '../../src/lib/search.js';

describe('rankDocuments', () => {
  const docs = [
    { id: 'a', text: 'Senior TypeScript engineer building Node.js services' },
    { id: 'b', text: 'Marketing manager for consumer products' },
    { id: 'c', text: 'TypeScript TypeScript TypeScript frontend' },
  ];
  it('ranks by distinct term matches first, then frequency', () => {
    const hits = rankDocuments('typescript node.js engineer', docs);
    expect(hits.map((h) => h.id)).toEqual(['a', 'c']);
    expect(hits[0].snippet).toContain('TypeScript');
  });
  it('returns nothing for no match or empty query', () => {
    expect(rankDocuments('plumber', docs)).toEqual([]);
    expect(rankDocuments('  ', docs)).toEqual([]);
  });
  it('respects the limit and keeps C# / C++ style tokens', () => {
    expect(rankDocuments('typescript', docs, 1)).toHaveLength(1);
    expect(tokenize('C# and C++ dev')).toEqual(['c#', 'and', 'c++', 'dev']);
  });
});
