import type { Db } from './index.js';
import { DEFAULT_CSS, DEFAULT_PREFERENCES } from '../cv/defaults.js';

export type JsonObject = Record<string, unknown>;

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface JobSummary {
  id: string;
  title: string;
  company: string;
  createdAt: string;
  updatedAt: string;
  cvChars: number;
}

export interface Job {
  id: string;
  cvId: string;
  data: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface CvBundle {
  cvId: string;
  jobId: string;
  html: string;
  css: string;
  preferences: JsonObject;
  updatedAt: string;
}

export interface ChatSessionData {
  messages: unknown[];
  activity: unknown[];
  [key: string]: unknown;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSession extends ChatSessionSummary {
  data: ChatSessionData;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const json = (v: unknown) => JSON.stringify(v ?? {});
const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

export class DuplicateEmailError extends Error {
  constructor() {
    super('An account with this email already exists');
  }
}

export function createRepo(db: Db) {
  const mapUser = (r: any): User => ({ id: r.id, email: r.email, name: r.name, createdAt: iso(r.created_at) });

  const repo = {
    db,

    // ---------- users & auth sessions ----------
    async createUser(input: { email: string; name: string; passwordHash: string }): Promise<User> {
      try {
        const { rows } = await db.query(
          `WITH u AS (
             INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING *
           ), p AS (
             INSERT INTO profiles (user_id, data) SELECT id, $4::jsonb FROM u
           )
           SELECT * FROM u`,
          [input.email.toLowerCase(), input.name, input.passwordHash, json(input.name ? { name: input.name } : {})],
        );
        return mapUser(rows[0]);
      } catch (err: any) {
        if (err?.code === '23505' || /duplicate key/i.test(String(err?.message))) throw new DuplicateEmailError();
        throw err;
      }
    },

    async findUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
      const { rows } = await db.query<any>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
      return rows[0] ? { ...mapUser(rows[0]), passwordHash: rows[0].password_hash } : null;
    },

    async getUser(id: string): Promise<User | null> {
      if (!isUuid(id)) return null;
      const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] ? mapUser(rows[0]) : null;
    },

    async createAuthSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
      await db.query('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
        tokenHash,
        userId,
        expiresAt.toISOString(),
      ]);
    },

    async getUserBySessionHash(tokenHash: string): Promise<User | null> {
      const { rows } = await db.query(
        `SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [tokenHash],
      );
      return rows[0] ? mapUser(rows[0]) : null;
    },

    async deleteAuthSession(tokenHash: string): Promise<void> {
      await db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash]);
    },

    async purgeExpiredSessions(): Promise<void> {
      await db.query('DELETE FROM auth_sessions WHERE expires_at <= now()');
    },

    // ---------- profile (1 per user) ----------
    async getProfile(userId: string): Promise<JsonObject> {
      const { rows } = await db.query<any>('SELECT data FROM profiles WHERE user_id = $1', [userId]);
      return rows[0] ? parse<JsonObject>(rows[0].data) : {};
    },

    async saveProfile(userId: string, data: JsonObject): Promise<JsonObject> {
      const { rows } = await db.query<any>(
        `INSERT INTO profiles (user_id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
         RETURNING data`,
        [userId, json(data)],
      );
      return parse<JsonObject>(rows[0].data);
    },

    // ---------- jobs (N per profile), each with exactly one CV, preferences and stylesheet ----------
    async listJobs(userId: string): Promise<JobSummary[]> {
      const { rows } = await db.query<any>(
        `SELECT j.id, j.data, j.created_at, j.updated_at, length(c.html) AS cv_chars
         FROM jobs j JOIN cvs c ON c.job_id = j.id
         WHERE j.user_id = $1 ORDER BY j.created_at`,
        [userId],
      );
      return rows.map((r) => {
        const data = parse<JsonObject>(r.data);
        return {
          id: r.id,
          title: String(data.title ?? data.role ?? 'Untitled job'),
          company: String(data.company ?? data.employer ?? ''),
          createdAt: iso(r.created_at),
          updatedAt: iso(r.updated_at),
          cvChars: Number(r.cv_chars ?? 0),
        };
      });
    },

    async createJob(
      userId: string,
      data: JsonObject,
      init: { css?: string; preferences?: JsonObject; html?: string } = {},
    ): Promise<Job> {
      const { rows } = await db.query<any>(
        `WITH j AS (
           INSERT INTO jobs (user_id, data) VALUES ($1, $2::jsonb) RETURNING *
         ), c AS (
           INSERT INTO cvs (job_id, html) SELECT id, $3 FROM j RETURNING id
         ), p AS (
           INSERT INTO cv_preferences (cv_id, data) SELECT id, $4::jsonb FROM c
         ), s AS (
           INSERT INTO cv_styles (cv_id, css) SELECT id, $5 FROM c
         )
         SELECT j.*, c.id AS cv_id FROM j, c`,
        [userId, json(data), init.html ?? '', json(init.preferences ?? DEFAULT_PREFERENCES), init.css ?? DEFAULT_CSS],
      );
      const r = rows[0];
      return { id: r.id, cvId: r.cv_id, data: parse(r.data), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
    },

    async getJob(userId: string, jobId: string): Promise<Job | null> {
      if (!isUuid(jobId)) return null;
      const { rows } = await db.query<any>(
        `SELECT j.*, c.id AS cv_id FROM jobs j JOIN cvs c ON c.job_id = j.id WHERE j.id = $1 AND j.user_id = $2`,
        [jobId, userId],
      );
      const r = rows[0];
      return r ? { id: r.id, cvId: r.cv_id, data: parse(r.data), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) } : null;
    },

    async saveJob(userId: string, jobId: string, data: JsonObject): Promise<Job | null> {
      if (!isUuid(jobId)) return null;
      const { rows } = await db.query<any>(
        `UPDATE jobs SET data = $3::jsonb, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id`,
        [jobId, userId, json(data)],
      );
      return rows[0] ? repo.getJob(userId, jobId) : null;
    },

    async deleteJob(userId: string, jobId: string): Promise<boolean> {
      if (!isUuid(jobId)) return false;
      const { rows } = await db.query('DELETE FROM jobs WHERE id = $1 AND user_id = $2 RETURNING id', [jobId, userId]);
      return rows.length > 0;
    },

    // ---------- CV / CSS / preferences ----------
    async getCv(userId: string, jobId: string): Promise<CvBundle | null> {
      if (!isUuid(jobId)) return null;
      const { rows } = await db.query<any>(
        `SELECT c.id AS cv_id, c.job_id, c.html, c.updated_at, s.css, p.data AS preferences
         FROM cvs c
         JOIN jobs j ON j.id = c.job_id
         JOIN cv_styles s ON s.cv_id = c.id
         JOIN cv_preferences p ON p.cv_id = c.id
         WHERE c.job_id = $1 AND j.user_id = $2`,
        [jobId, userId],
      );
      const r = rows[0];
      return r
        ? { cvId: r.cv_id, jobId: r.job_id, html: r.html, css: r.css, preferences: parse(r.preferences), updatedAt: iso(r.updated_at) }
        : null;
    },

    async saveCvHtml(userId: string, jobId: string, html: string): Promise<boolean> {
      if (!isUuid(jobId)) return false;
      const { rows } = await db.query(
        `UPDATE cvs c SET html = $3, updated_at = now() FROM jobs j
         WHERE c.job_id = j.id AND j.id = $1 AND j.user_id = $2 RETURNING c.id`,
        [jobId, userId, html],
      );
      return rows.length > 0;
    },

    async saveCss(userId: string, jobId: string, css: string): Promise<boolean> {
      if (!isUuid(jobId)) return false;
      const { rows } = await db.query(
        `UPDATE cv_styles s SET css = $3, updated_at = now() FROM cvs c JOIN jobs j ON j.id = c.job_id
         WHERE s.cv_id = c.id AND j.id = $1 AND j.user_id = $2 RETURNING s.cv_id`,
        [jobId, userId, css],
      );
      return rows.length > 0;
    },

    async savePreferences(userId: string, jobId: string, data: JsonObject): Promise<boolean> {
      if (!isUuid(jobId)) return false;
      const { rows } = await db.query(
        `UPDATE cv_preferences p SET data = $3::jsonb, updated_at = now() FROM cvs c JOIN jobs j ON j.id = c.job_id
         WHERE p.cv_id = c.id AND j.id = $1 AND j.user_id = $2 RETURNING p.cv_id`,
        [jobId, userId, json(data)],
      );
      return rows.length > 0;
    },

    // ---------- chat sessions (independent) ----------
    async listChatSessions(userId: string): Promise<ChatSessionSummary[]> {
      const { rows } = await db.query<any>(
        'SELECT id, title, created_at, updated_at FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC',
        [userId],
      );
      return rows.map((r) => ({ id: r.id, title: r.title, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }));
    },

    async createChatSession(userId: string, title = 'New chat'): Promise<ChatSession> {
      const { rows } = await db.query<any>('INSERT INTO chat_sessions (user_id, title) VALUES ($1, $2) RETURNING *', [userId, title]);
      return mapSession(rows[0]);
    },

    async getChatSession(userId: string, id: string): Promise<ChatSession | null> {
      if (!isUuid(id)) return null;
      const { rows } = await db.query<any>('SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2', [id, userId]);
      return rows[0] ? mapSession(rows[0]) : null;
    },

    async saveChatSession(userId: string, id: string, patch: { title?: string; data?: ChatSessionData }): Promise<boolean> {
      if (!isUuid(id)) return false;
      const { rows } = await db.query(
        `UPDATE chat_sessions SET
           title = COALESCE($3, title),
           data = COALESCE($4::jsonb, data),
           updated_at = now()
         WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, userId, patch.title ?? null, patch.data ? json(patch.data) : null],
      );
      return rows.length > 0;
    },

    async deleteChatSession(userId: string, id: string): Promise<boolean> {
      if (!isUuid(id)) return false;
      const { rows } = await db.query('DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
      return rows.length > 0;
    },
  };

  function mapSession(r: any): ChatSession {
    const data = parse<ChatSessionData>(r.data) ?? { messages: [], activity: [] };
    return {
      id: r.id,
      title: r.title,
      data: { ...data, messages: data.messages ?? [], activity: data.activity ?? [] },
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  return repo;
}

export type Repo = ReturnType<typeof createRepo>;
