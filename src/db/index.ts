import pg from 'pg';
import { mkdirSync } from 'node:fs';

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  /** Run a multi-statement SQL script (no parameters). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Real PostgreSQL (Railway, production). */
export function createPgDb(connectionString: string): Db {
  const needsSsl = /sslmode=require/.test(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  return {
    kind: 'pg',
    async query(sql, params) {
      const res = await pool.query(sql, params as any[]);
      return { rows: res.rows };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async (sql, params) => ({ rows: (await client.query(sql, params as any[])).rows }),
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** Embedded Postgres (WASM) for local development and tests — no server or Docker needed. */
export async function createPgliteDb(dir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const inMemory = !dir || dir === ':memory:';
  if (!inMemory) mkdirSync(dir, { recursive: true });
  const db = inMemory ? new PGlite() : new PGlite(dir);
  await db.waitReady;
  return {
    kind: 'pglite',
    async query(sql, params) {
      const res = await db.query(sql, params as any[]);
      return { rows: res.rows as any[] };
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async transaction(fn) {
      return db.transaction(async (tx) =>
        fn({ query: async (sql, params) => ({ rows: (await tx.query(sql, params as any[])).rows as any[] }) }),
      );
    },
    async close() {
      await db.close();
    },
  };
}

export async function createDb(opts: { databaseUrl?: string; pgliteDir?: string }): Promise<Db> {
  if (opts.databaseUrl) return createPgDb(opts.databaseUrl);
  return createPgliteDb(opts.pgliteDir ?? ':memory:');
}
