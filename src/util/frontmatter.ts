export type FrontmatterValue = string | boolean | number | string[];

export interface ParsedDocument {
  data: Record<string, FrontmatterValue>;
  body: string;
}

function parseScalar(raw: string): string | boolean | number {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return unquote(v);
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/**
 * Parses a small YAML subset used by skill files: `key: value`, `key: [a, b]`,
 * and block lists (`key:` followed by `  - item` lines).
 */
export function parseFrontmatter(text: string): ParsedDocument {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, FrontmatterValue> = {};
  let listKey: string | null = null;
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1] ?? ''));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv?.[1]) continue;
    const key = kv[1];
    const value = kv[2] ?? '';
    listKey = null;
    if (value.trim() === '') {
      data[key] = [];
      listKey = key;
    } else if (value.trim().startsWith('[') && value.trim().endsWith(']')) {
      data[key] = value
        .trim()
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s))
        .filter(Boolean);
    } else {
      data[key] = parseScalar(value);
    }
  }
  return { data, body: (m[2] ?? '').replace(/^\s*\n/, '') };
}

function formatValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) return `[${value.map((v) => (/[,\]\[:#]/.test(v) ? JSON.stringify(v) : v)).join(', ')}]`;
  if (typeof value === 'string') return /^[\s]|[\s]$|^[\[{"'>|*&!%@`]|: | #|^(true|false|-?\d+(\.\d+)?)$/.test(value) || value === '' ? JSON.stringify(value) : value;
  return String(value);
}

export function stringifyFrontmatter(data: Record<string, FrontmatterValue | undefined>, body: string): string {
  const lines = Object.entries(data)
    .filter((e): e is [string, FrontmatterValue] => e[1] !== undefined)
    .map(([k, v]) => `${k}: ${formatValue(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}
