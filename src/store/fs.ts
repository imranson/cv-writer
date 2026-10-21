import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function assertId(id: string, what = 'id'): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid ${what}: ${JSON.stringify(id)}`);
  return id;
}

/** Writes via a temp file + rename so readers never see a half-written file. */
export async function writeFileAtomic(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, file);
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  const text = await readText(file);
  return text === undefined ? undefined : (JSON.parse(text) as T);
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function removeFile(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (err: any) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/** Lists ids of files with `ext` in `dir` (empty if the directory does not exist). */
export async function listIds(dir: string, ext: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => n.endsWith(ext) && !n.endsWith('.tmp')).map((n) => n.slice(0, -ext.length));
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}
