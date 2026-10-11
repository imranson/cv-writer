import { randomBytes } from 'node:crypto';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

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

export function shortId(length = 6): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Human-readable unique id, e.g. `acme-data-engineer-k3x9qp`. */
export function makeId(...parts: (string | undefined)[]): string {
  const slug = slugify(parts.filter(Boolean).join(' '));
  return slug ? `${slug}-${shortId()}` : shortId(10);
}

/** Ids end up in file paths, so anything outside the safe alphabet is rejected. */
export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function assertValidId(id: string, what = 'id'): string {
  if (!isValidId(id)) throw new InvalidIdError(`Invalid ${what}: "${id}"`);
  return id;
}

export class InvalidIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdError';
  }
}
