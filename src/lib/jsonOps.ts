/**
 * Small JSON document helpers used by the read/edit tools:
 * path parsing ("experience[0].highlights"), patch operations and full-text search.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type PathSegment = string | number;

export interface JsonOp {
  op: 'set' | 'merge' | 'append' | 'remove';
  path: string;
  value?: unknown;
}

export function parsePath(path: string): PathSegment[] {
  const trimmed = path.trim().replace(/^\$\.?/, '');
  if (trimmed === '' || trimmed === '.') return [];
  const segments: PathSegment[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]|\[["']([^"']+)["']\]/g;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed))) {
    const between = trimmed.slice(consumed, m.index);
    if (between.replace(/\./g, '') !== '') throw new Error(`Invalid path "${path}"`);
    consumed = m.index + m[0].length;
    if (m[1] !== undefined) segments.push(/^\d+$/.test(m[1]) ? Number(m[1]) : m[1]);
    else if (m[2] !== undefined) segments.push(Number(m[2]));
    else segments.push(m[3]);
  }
  if (trimmed.slice(consumed).replace(/\./g, '') !== '') throw new Error(`Invalid path "${path}"`);
  return segments;
}

export function formatPath(segments: PathSegment[]): string {
  return segments.reduce<string>((acc, seg) => {
    if (typeof seg === 'number') return `${acc}[${seg}]`;
    return /^[A-Za-z_$][\w$-]*$/.test(seg) ? (acc ? `${acc}.${seg}` : seg) : `${acc}["${seg}"]`;
  }, '');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function getAt(doc: unknown, path: string | PathSegment[]): unknown {
  const segments = typeof path === 'string' ? parsePath(path) : path;
  let cur: unknown = doc;
  for (const seg of segments) {
    if (Array.isArray(cur) && typeof seg === 'number') cur = cur[seg];
    else if (isObject(cur) && typeof seg === 'string') cur = cur[seg];
    else if (isObject(cur) && typeof seg === 'number') cur = cur[String(seg)];
    else return undefined;
  }
  return cur;
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (!isObject(target) || !isObject(source)) return structuredClone(source);
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(source)) out[k] = k in out ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}

/** Walks to the parent of the final segment, creating containers as needed. */
function parentOf(root: Record<string, unknown>, segments: PathSegment[], create: boolean): { parent: any; key: PathSegment } {
  let cur: any = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    let next = cur[seg as any];
    if (next === undefined || next === null || typeof next !== 'object') {
      if (!create) throw new Error(`Path not found: ${formatPath(segments.slice(0, i + 1))}`);
      next = typeof segments[i + 1] === 'number' ? [] : {};
      cur[seg as any] = next;
    }
    cur = next;
  }
  return { parent: cur, key: segments[segments.length - 1] };
}

export function applyOps<T extends object>(doc: T, ops: JsonOp[]): T {
  let root: any = structuredClone(doc ?? {});
  for (const { op, path, value } of ops) {
    const segments = parsePath(path);
    if (segments.length === 0) {
      if (op === 'set') {
        if (!isObject(value)) throw new Error('Root value must be an object');
        root = structuredClone(value);
      } else if (op === 'merge') {
        if (!isObject(value)) throw new Error('merge value must be an object');
        root = deepMerge(root, value);
      } else throw new Error(`Operation "${op}" needs a non-empty path`);
      continue;
    }
    switch (op) {
      case 'set': {
        const { parent, key } = parentOf(root, segments, true);
        parent[key as any] = structuredClone(value);
        break;
      }
      case 'merge': {
        const { parent, key } = parentOf(root, segments, true);
        parent[key as any] = deepMerge(parent[key as any], value);
        break;
      }
      case 'append': {
        const { parent, key } = parentOf(root, segments, true);
        const current = parent[key as any];
        if (current === undefined || current === null) parent[key as any] = [structuredClone(value)];
        else if (Array.isArray(current)) current.push(structuredClone(value));
        else throw new Error(`Cannot append: ${path} is not an array`);
        break;
      }
      case 'remove': {
        const { parent, key } = parentOf(root, segments, false);
        if (Array.isArray(parent) && typeof key === 'number') {
          if (key >= parent.length) throw new Error(`Path not found: ${path}`);
          parent.splice(key, 1);
        } else if (isObject(parent) && String(key) in parent) {
          delete parent[String(key)];
        } else throw new Error(`Path not found: ${path}`);
        break;
      }
      default:
        throw new Error(`Unknown operation "${op as string}"`);
    }
  }
  return root;
}

export interface SearchMatch {
  path: string;
  value: unknown;
}

/**
 * Case-insensitive search. Every whitespace-separated term must appear in the
 * leaf value or in its path. Returns leaf matches (strings, numbers, booleans).
 */
export function searchJson(doc: unknown, query: string, limit = 50): SearchMatch[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const matches: SearchMatch[] = [];
  const visit = (value: unknown, segments: PathSegment[]) => {
    if (matches.length >= limit) return;
    if (Array.isArray(value)) value.forEach((v, i) => visit(v, [...segments, i]));
    else if (isObject(value)) for (const [k, v] of Object.entries(value)) visit(v, [...segments, k]);
    else if (value !== null && value !== undefined) {
      const path = formatPath(segments);
      const haystack = `${path} ${String(value)}`.toLowerCase();
      if (terms.every((t) => haystack.includes(t))) matches.push({ path, value });
    }
  };
  visit(doc, []);
  return matches;
}

/** Applies find/replace edits to text. Each `find` must match exactly once unless `all` is set. */
export function applyTextEdits(text: string, edits: { find: string; replace: string; all?: boolean }[]): string {
  let out = text;
  for (const [i, { find, replace, all }] of edits.entries()) {
    if (!find) throw new Error(`Edit ${i + 1}: "find" must not be empty`);
    const count = out.split(find).length - 1;
    if (count === 0) throw new Error(`Edit ${i + 1}: text to find was not found`);
    if (count > 1 && !all) throw new Error(`Edit ${i + 1}: text to find occurs ${count} times; make it unique or set all=true`);
    out = all ? out.split(find).join(replace) : out.replace(find, () => replace);
  }
  return out;
}
