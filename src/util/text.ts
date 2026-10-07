/** Rough token estimate used for context budgeting (about four characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Numbers as written in prose ("1,200", "45%", "3.5x", "£2m") reduced to their digits for comparison. */
export function extractNumbers(text: string): string[] {
  const found = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return found.map((n) => n.replace(/,/g, '').replace(/\.0+$/, '')).filter((n) => n.length > 0);
}

/** Removes null values recursively; open models often send null for "not provided". */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== null).map(stripNulls);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v);
    return out;
  }
  return value;
}

/** Some models leak their reasoning into the reply, ending it with </think>. Keep only the answer. */
export function stripThinking(content: string): string {
  const end = content.lastIndexOf('</think>');
  const answer = end >= 0 ? content.slice(end + '</think>'.length) : content;
  return answer.replace(/^\s*<think>[\s\S]*$/, '').trim();
}

export function normaliseTerm(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
}
