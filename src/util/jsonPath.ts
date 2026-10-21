// Small dotted-path helpers used by the profile/job tools.
// Paths look like `experience[0].highlights` or `experience.0.highlights`.

export type PathKey = string | number;
type Json = unknown;

export function parsePath(path: string): PathKey[] {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '$') return [];
  const keys: PathKey[] = [];
  const re = /([^.[\]]+)|\[(\d+|-)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed))) {
    if (match[2] !== undefined) keys.push(match[2] === '-' ? '-' : Number(match[2]));
    else if (/^\d+$/.test(match[1])) keys.push(Number(match[1]));
    else keys.push(match[1]);
  }
  for (const key of keys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`Illegal path segment "${key}"`);
    }
  }
  return keys;
}

export function formatPath(keys: PathKey[]): string {
  return keys
    .map((k, i) => (typeof k === 'number' ? `[${k}]` : i === 0 ? k : `.${k}`))
    .join('');
}

export function getPath(root: Json, path: string): Json {
  let node: any = root;
  for (const key of parsePath(path)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key as any];
  }
  return node;
}

function parentOf(root: any, keys: PathKey[], create: boolean): any {
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (node[key as any] === undefined || node[key as any] === null) {
      if (!create) return undefined;
      node[key as any] = typeof keys[i + 1] === 'number' || keys[i + 1] === '-' ? [] : {};
    }
    node = node[key as any];
    if (typeof node !== 'object') throw new Error(`Cannot descend into non-object at "${formatPath(keys.slice(0, i + 1))}"`);
  }
  return node;
}

/** Returns a new object with `value` set at `path` (creating intermediate containers). */
export function setPath<T>(root: T, path: string, value: Json): T {
  const keys = parsePath(path);
  if (keys.length === 0) return value as T;
  const copy = structuredClone(root ?? {}) as any;
  const parent = parentOf(copy, keys, true);
  const last = keys[keys.length - 1];
  if (last === '-' && Array.isArray(parent)) parent.push(value);
  else parent[last as any] = value;
  return copy;
}

/** Appends `value` to the array at `path` (creating it if missing). */
export function appendPath<T>(root: T, path: string, value: Json): T {
  const current = getPath(root, path);
  if (current === undefined || current === null) return setPath(root, path, [value]);
  if (!Array.isArray(current)) throw new Error(`Value at "${path}" is not an array`);
  return setPath(root, path, [...current, value]);
}

/** Removes the key or array element at `path`. */
export function removePath<T>(root: T, path: string): T {
  const keys = parsePath(path);
  if (keys.length === 0) throw new Error('Cannot remove the root');
  const copy = structuredClone(root) as any;
  const parent = parentOf(copy, keys, false);
  const last = keys[keys.length - 1];
  if (parent === undefined || !(last in Object(parent))) throw new Error(`Nothing at "${path}"`);
  if (Array.isArray(parent) && typeof last === 'number') parent.splice(last, 1);
  else delete parent[last as any];
  return copy;
}

/** Recursively merges plain objects; arrays and scalars in `patch` replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return structuredClone(patch) as T;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor') continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export interface SearchHit {
  path: string;
  value: Json;
}

/**
 * Case-insensitive search over keys and scalar values. Every whitespace-separated
 * term must occur in either the leaf's path or its value.
 */
export function searchJson(root: Json, query: string, limit = 30): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];
  if (terms.length === 0) return hits;
  const walk = (node: Json, keys: PathKey[]) => {
    if (hits.length >= limit) return;
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, [...keys, Array.isArray(node) ? Number(k) : k]);
      return;
    }
    const path = formatPath(keys);
    const haystack = `${path} ${String(node)}`.toLowerCase();
    if (terms.every((t) => haystack.includes(t))) hits.push({ path, value: node });
  };
  walk(root, []);
  return hits;
}
