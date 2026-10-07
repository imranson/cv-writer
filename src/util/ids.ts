import { randomBytes } from 'node:crypto';

export function shortId(bytes = 3): string {
  return randomBytes(bytes).toString('hex');
}

export function slugify(text: string, max = 48): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'item'
  );
}

export function versionFile(version: number): string {
  return `v${String(version).padStart(3, '0')}.json`;
}
