import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { assertValidId, isValidId } from '../lib/ids.js';

/** One directory of documents, one file per id. No schema is enforced. */
export class FileStore<T> {
  constructor(
    readonly dir: string,
    private readonly ext: string,
    private readonly serialize: (value: T) => string,
    private readonly parse: (raw: string) => T,
  ) {}

  private file(id: string): string {
    assertValidId(id);
    return path.join(this.dir, `${id}${this.ext}`);
  }

  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith(this.ext))
      .map((n) => n.slice(0, -this.ext.length))
      .filter(isValidId)
      .sort();
  }

  async read(id: string): Promise<T | undefined> {
    try {
      return this.parse(await readFile(this.file(id), 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async exists(id: string): Promise<boolean> {
    return (await this.modifiedAt(id)) !== undefined;
  }

  async modifiedAt(id: string): Promise<Date | undefined> {
    try {
      return (await stat(this.file(id))).mtime;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /** Atomic write (temp file + rename) so readers never see a half-written file. */
  async write(id: string, value: T): Promise<void> {
    const target = this.file(id);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, this.serialize(value), 'utf8');
    await rename(tmp, target);
  }

  async delete(id: string): Promise<boolean> {
    const existed = await this.exists(id);
    await rm(this.file(id), { force: true });
    return existed;
  }
}

export type JsonDoc = Record<string, unknown>;

export function jsonStore<T = JsonDoc>(dir: string): FileStore<T> {
  return new FileStore<T>(dir, '.json', (v) => `${JSON.stringify(v, null, 2)}\n`, (raw) => JSON.parse(raw) as T);
}

export function textStore(dir: string, ext: string): FileStore<string> {
  return new FileStore<string>(dir, ext, (v) => v, (raw) => raw);
}
