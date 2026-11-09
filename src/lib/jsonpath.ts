/**
 * Small JSON document helpers used by the read/edit tools.
 * Paths look like `experience[0].highlights[2]`, `basics.links.1.url` or `skills[]` (append).
 */

export type Segment = string | number | typeof APPEND;
export const APPEND = Symbol('append');

export function parsePath(path: string): Segment[] {
  const trimmed = path.trim().replace(/^\$\.?/, '');
  if (!trimmed) return [];
  const segments: Segment[] = [];
  const re = /([^.[\]]+)|\[(\d*|-)\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(trimmed))) {
    const between = trimmed.slice(consumed, m.index);
    if (between && between !== '.') throw new Error(`Invalid path "${path}"`);
    consumed = m.index + m[0].length;
    if (m[1] !== undefined) {
      segments.push(/^\d+$/.test(m[1]) ? Number(m[1]) : m[1]);
    } else {
      segments.push(m[2] === '' || m[2] === '-' ? APPEND : Number(m[2]));
    }
  }
  if (consumed !== trimmed.length) throw new Error(`Invalid path "${path}"`);
  return segments;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function getAt(doc: unknown, path: string): unknown {
  let cur: any = doc;
  for (const seg of parsePath(path)) {
    if (seg === APPEND || cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg as string];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Returns a deep-cloned document with `value` set at `path`, creating containers as needed. */
export function setAt<T>(doc: T, path: string, value: unknown): T {
  const segs = parsePath(path);
  if (segs.length === 0) return structuredClone(value) as T;
  const root: any = structuredClone(doc ?? {});
  let cur: any = root;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    const nextIsIndex = !last && (typeof segs[i + 1] === 'number' || segs[i + 1] === APPEND);
    if (Array.isArray(cur)) {
      const idx = seg === APPEND ? cur.length : Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx > cur.length) {
        throw new Error(`Index ${String(seg)} out of range at "${path}" (length ${cur.length})`);
      }
      if (last) cur[idx] = structuredClone(value);
      else {
        if (cur[idx] === undefined || cur[idx] === null) cur[idx] = nextIsIndex ? [] : {};
        else if (typeof cur[idx] !== 'object') throw new Error(`Cannot set "${path}": parent is not an object or array`);
        cur = cur[idx];
      }
    } else if (isObj(cur)) {
      if (seg === APPEND) throw new Error(`Cannot append to a non-array at "${path}"`);
      const key = String(seg);
      if (last) cur[key] = structuredClone(value);
      else {
        if (cur[key] === undefined || cur[key] === null) cur[key] = nextIsIndex ? [] : {};
        else if (typeof cur[key] !== 'object') throw new Error(`Cannot set "${path}": parent is not an object or array`);
        cur = cur[key];
      }
    } else {
      throw new Error(`Cannot set "${path}": parent is not an object or array`);
    }
  }
  return root;
}

/** Returns [newDoc, removed?]. Array elements are spliced out. */
export function deleteAt<T>(doc: T, path: string): [T, boolean] {
  const segs = parsePath(path);
  if (segs.length === 0) throw new Error('Refusing to delete the document root');
  const root: any = structuredClone(doc);
  let cur: any = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (seg === APPEND || cur === null || typeof cur !== 'object') return [root, false];
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg as string];
  }
  const lastSeg = segs[segs.length - 1];
  if (cur === null || typeof cur !== 'object' || lastSeg === APPEND) return [root, false];
  if (Array.isArray(cur)) {
    const idx = Number(lastSeg);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return [root, false];
    cur.splice(idx, 1);
    return [root, true];
  }
  if (!(String(lastSeg) in cur)) return [root, false];
  delete cur[String(lastSeg)];
  return [root, true];
}

/** RFC 7386 JSON Merge Patch: objects merge recursively, `null` deletes a key, everything else replaces. */
export function mergePatch(target: unknown, patch: unknown): any {
  if (!isObj(patch)) return structuredClone(patch);
  const result: Record<string, any> = isObj(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

export interface SearchHit {
  path: string;
  value: unknown;
  score: number;
}

/** Case-insensitive keyword search across every leaf (path + value). Best matches first. */
export function searchJson(doc: unknown, query: string, limit = 40): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  const walk = (node: unknown, path: string) => {
    if (node !== null && typeof node === 'object') {
      const entries = Array.isArray(node) ? node.map((v, i) => [i, v] as const) : Object.entries(node);
      if (entries.length === 0) return;
      for (const [k, v] of entries) walk(v, typeof k === 'number' ? `${path}[${k}]` : path ? `${path}.${k}` : k);
      return;
    }
    const haystack = `${path} ${String(node)}`.toLowerCase();
    const score = terms.reduce((n, t) => n + (haystack.includes(t) ? 1 : 0), 0);
    if (score > 0) hits.push({ path, value: node, score });
  };
  walk(doc, '');
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** One-level outline of a document: keys with a short description of each value. */
export function outline(doc: unknown): Record<string, string> {
  if (!isObj(doc)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (Array.isArray(v)) out[k] = `array(${v.length})`;
    else if (isObj(v)) out[k] = `object{${Object.keys(v).slice(0, 8).join(', ')}}`;
    else if (typeof v === 'string') out[k] = v.length > 60 ? `"${v.slice(0, 57)}..."` : JSON.stringify(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}
