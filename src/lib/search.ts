export interface SearchHit {
  id: string;
  score: number;
  snippet: string;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((t) => t.length > 1);
}

function snippetAround(text: string, terms: string[], radius = 90): string {
  const lower = text.toLowerCase();
  let index = -1;
  for (const term of terms) {
    index = lower.indexOf(term);
    if (index !== -1) break;
  }
  if (index === -1) return text.slice(0, radius * 2).trim();
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Keyword search: scores each document by term frequency, boosting documents
 * that match more distinct terms and that contain the exact phrase.
 */
export function rankDocuments(query: string, docs: { id: string; text: string }[], limit = 10): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    let matched = 0;
    let frequency = 0;
    for (const term of terms) {
      const c = counts.get(term) ?? 0;
      if (c > 0) matched++;
      frequency += Math.min(c, 5);
    }
    if (matched === 0) continue;
    const phraseBonus = terms.length > 1 && doc.text.toLowerCase().includes(phrase) ? 5 : 0;
    const score = matched * 10 + frequency + phraseBonus;
    hits.push({ id: doc.id, score, snippet: snippetAround(doc.text, terms) });
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
