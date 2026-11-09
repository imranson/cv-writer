import type { Db } from './index.js';

/** Ordered, append-only list of schema migrations. Never edit an applied migration; add a new one. */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

      -- 1 user : 1 profile (JSON)
      CREATE TABLE profiles (
        user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data       JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- 1 user : N jobs (JSON)
      CREATE TABLE jobs (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        data       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX jobs_user_idx ON jobs(user_id, created_at);

      -- 1 job : 1 CV (HTML)
      CREATE TABLE cvs (
        id         TEXT PRIMARY KEY,
        job_id     TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        html       TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- 1 CV : 1 preferences (JSON)
      CREATE TABLE cv_preferences (
        cv_id      TEXT PRIMARY KEY REFERENCES cvs(id) ON DELETE CASCADE,
        data       JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- 1 CV : 1 CSS style sheet
      CREATE TABLE cv_styles (
        cv_id      TEXT PRIMARY KEY REFERENCES cvs(id) ON DELETE CASCADE,
        css        TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Chat sessions (JSON), independent of jobs
      CREATE TABLE chat_sessions (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT NOT NULL DEFAULT 'New chat',
        data       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX chat_sessions_user_idx ON chat_sessions(user_id, updated_at DESC);
    `,
  },
];

export async function migrate(db: Db): Promise<number[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INT PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.transaction(async (tx) => {
      for (const stmt of splitSql(m.sql)) await tx.query(stmt);
      await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
    });
    ran.push(m.version);
  }
  return ran;
}

/** Splits a migration script into statements (migrations contain no semicolons inside literals). */
export function splitSql(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
