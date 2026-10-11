/**
 * Path-based edits for schemaless JSON documents.
 * Paths use dots and/or brackets: `experience.0.title`, `experience[0].bullets`.
 */

export type JsonOp =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'delete'; path: string }
  | { op: 'append'; path: string; value: unknown }
  | { op: 'merge'; path: string; value: Record<string, unknown> };

type Container = Record<string, unknown> | unknown[];

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

export function parsePath(path: string): string[] {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const s of segments) {
    if (FORBIDDEN.has(s)) throw new Error(`Forbidden path segment "${s}"`);
  }
  return segments;
}

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isContainer(value) && !Array.isArray(value);
}

function getChild(container: Container, key: string): unknown {
  if (Array.isArray(container)) return container[Number(key)];
  return Object.hasOwn(container, key) ? container[key] : undefined;
}

function setChild(container: Container, key: string, value: unknown): void {
  if (Array.isArray(container)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index > container.length) {
      throw new Error(`Array index "${key}" out of range (length ${container.length})`);
    }
    container[index] = value;
  } else {
    container[key] = value;
  }
}

/** Walks to the parent of the final segment, creating objects/arrays as needed. */
function walkToParent(root: Container, segments: string[]): Container {
  let current: Container = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    let next = getChild(current, key);
    if (next === undefined || next === null) {
      next = /^\d+$/.test(segments[i + 1]) ? [] : {};
      setChild(current, key, next);
    }
    if (!isContainer(next)) {
      throw new Error(`Cannot descend into "${segments.slice(0, i + 1).join('.')}": it is a ${typeof next}`);
    }
    current = next;
  }
  return current;
}

export function getAtPath(root: unknown, path: string): unknown {
  let current = root;
  for (const key of parsePath(path)) {
    if (!isContainer(current)) return undefined;
    current = getChild(current, key);
  }
  return current;
}

function applyOne(root: Record<string, unknown>, op: JsonOp): void {
  const segments = parsePath(op.path);
  switch (op.op) {
    case 'set': {
      if (segments.length === 0) throw new Error('"set" needs a non-empty path; use "merge" for the root');
      setChild(walkToParent(root, segments), segments.at(-1)!, op.value);
      return;
    }
    case 'delete': {
      if (segments.length === 0) throw new Error('"delete" needs a non-empty path');
      const parent = getAtPath(root, segments.slice(0, -1).join('.'));
      const key = segments.at(-1)!;
      if (!isContainer(parent) || getChild(parent, key) === undefined) {
        throw new Error(`Nothing to delete at "${op.path}"`);
      }
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
      return;
    }
    case 'append': {
      if (segments.length === 0) throw new Error('"append" needs a path to an array');
      const parent = walkToParent(root, segments);
      const key = segments.at(-1)!;
      const existing = getChild(parent, key);
      if (existing === undefined || existing === null) setChild(parent, key, [op.value]);
      else if (Array.isArray(existing)) existing.push(op.value);
      else throw new Error(`Cannot append: "${op.path}" is not an array`);
      return;
    }
    case 'merge': {
      if (!isPlainObject(op.value)) throw new Error('"merge" value must be an object');
      for (const key of Object.keys(op.value)) {
        if (FORBIDDEN.has(key)) throw new Error(`Forbidden key "${key}"`);
      }
      if (segments.length === 0) {
        Object.assign(root, op.value);
        return;
      }
      const parent = walkToParent(root, segments);
      const key = segments.at(-1)!;
      const existing = getChild(parent, key);
      if (existing === undefined || existing === null) setChild(parent, key, { ...op.value });
      else if (isPlainObject(existing)) Object.assign(existing, op.value);
      else throw new Error(`Cannot merge: "${op.path}" is not an object`);
      return;
    }
    default:
      throw new Error(`Unknown op "${(op as { op: string }).op}"`);
  }
}

/** Applies ops to a deep copy; throws (leaving the input untouched) if any op fails. */
export function applyJsonOps<T extends Record<string, unknown>>(doc: T, ops: JsonOp[]): T {
  const copy = structuredClone(doc);
  ops.forEach((op, i) => {
    try {
      applyOne(copy, op);
    } catch (err) {
      throw new Error(`Operation ${i + 1} (${op.op} "${op.path}") failed: ${(err as Error).message}`);
    }
  });
  return copy;
}
