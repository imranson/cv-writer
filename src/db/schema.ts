import type { Db } from './index.js';

/**
 * Data model (per user):
 *   users 1─1 profiles (JSON)
 *   profiles 1─N jobs (JSON)
 *   jobs 1─1 cvs (HTML)
 *   cvs 1─1 cv_preferences (JSON)
 *   cvs 1─1 cv_styles (raw CSS)
 *   users 1─N chat_sessions (JSON) — independent of jobs
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_data_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_data_object CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX jobs_user_idx ON jobs(user_id, created_at);

CREATE TABLE cvs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  html text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cv_preferences (
  cv_id uuid PRIMARY KEY REFERENCES cvs(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cv_preferences_data_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE cv_styles (
  cv_id uuid PRIMARY KEY REFERENCES cvs(id) ON DELETE CASCADE,
  css text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New chat',
  data jsonb NOT NULL DEFAULT '{"messages":[],"activity":[]}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_sessions_user_idx ON chat_sessions(user_id, updated_at DESC);
`,
  },
];

export async function migrate(db: Db): Promise<number[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.exec(`BEGIN;\n${m.sql}\nINSERT INTO schema_migrations (version, name) VALUES (${m.version}, '${m.name.replace(/'/g, "''")}');\nCOMMIT;`);
    ran.push(m.version);
  }
  return ran;
}
