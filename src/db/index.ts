import { mkdir } from 'node:fs/promises';

export interface QueryResult<T> {
  rows: T[];
}

/** Minimal database surface shared by node-postgres (production) and PGlite (dev/tests). */
export interface Db {
  readonly kind: 'postgres' | 'pglite';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs a multi-statement script without parameters. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface DbOptions {
  databaseUrl?: string;
  /** Directory for embedded PGlite data; `memory://` (or undefined) keeps it in memory. */
  pgliteDir?: string;
}

export async function createDb(opts: DbOptions): Promise<Db> {
  if (opts.databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 });
    pool.on('error', (err) => console.error('[db] idle client error', err));
    return {
      kind: 'postgres',
      query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params as unknown[])).rows as T[] }),
      exec: async (sql) => {
        await pool.query(sql);
      },
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const dir = opts.pgliteDir && opts.pgliteDir !== 'memory://' ? opts.pgliteDir : undefined;
  if (dir) await mkdir(dir, { recursive: true });
  const lite = dir ? new PGlite(dir) : new PGlite();
  await lite.waitReady;
  return {
    kind: 'pglite',
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await lite.query<T>(sql, params as unknown[])).rows }),
    exec: async (sql) => {
      await lite.exec(sql);
    },
    close: () => lite.close(),
  };
}
