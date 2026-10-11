import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function readJsonOptional<T>(file: string): Promise<T | null> {
  const text = await readOptional(file);
  return text === null ? null : (JSON.parse(text) as T);
}

/** Write via a temp file + rename so readers never observe a half-written file. */
export async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
