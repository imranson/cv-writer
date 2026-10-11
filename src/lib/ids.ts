import { randomBytes } from 'node:crypto';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** True when `id` is safe to use as a file name (no traversal, no separators). */
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

export function assertValidId(id: unknown, kind = 'id'): asserts id is string {
  if (!isValidId(id)) {
    throw new Error(`Invalid ${kind} "${String(id)}": use lowercase letters, digits and dashes (max 80 chars).`);
  }
}

export function slugify(text: string, maxLength = 40): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/** Readable unique id such as `job-acme-backend-engineer-3f9a1c`. */
export function newId(prefix: string, hint?: string): string {
  const slug = hint ? slugify(hint) : '';
  const suffix = randomBytes(3).toString('hex');
  return [prefix, slug, suffix].filter(Boolean).join('-');
}
