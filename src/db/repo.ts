import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from './index.js';
import { DEFAULT_CSS, defaultJob, defaultPreferences, defaultProfile } from './defaults.js';

export type Json = Record<string, any>;

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface JobSummary {
  id: string;
  cvId: string;
  title: string;
  company: string;
  status: string;
  hasCv: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  cvId: string;
  data: Json;
  createdAt: string;
  updatedAt: string;
}

export interface CvRecord {
  id: string;
  jobId: string;
  html: string;
  updatedAt: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  data: ChatData;
  createdAt: string;
  updatedAt: string;
}

export interface ChatData {
  /** Raw coordinator transcript (LLM messages incl. tool calls/results). */
  messages?: any[];
  /** UI turns: user text, assistant answer and the full agent activity tree. */
  turns?: any[];
  focusJobId?: string | null;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const jsonParam = (v: unknown) => JSON.stringify(v ?? {});

/**
 * All data access. Every method that touches user-owned data takes the userId and scopes the query
 * by it, so one account can never read or write another account's records.
 */
export class Repo {
  constructor(private readonly db: Db) {}

  // ---------- users & sessions ----------

  async createUser(input: { email: string; name: string; passwordHash: string }): Promise<User> {
    const id = randomUUID();
    const email = input.email.trim().toLowerCase();
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, created_at`,
        [id, email, input.name.trim(), input.passwordHash],
      );
      await tx.query('INSERT INTO profiles (user_id, data) VALUES ($1, $2::jsonb)', [
        id,
        jsonParam(defaultProfile(input.name.trim(), email)),
      ]);
      return mapUser(rows[0]);
    });
  }

  async getUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
    const { rows } = await this.db.query(
      'SELECT id, email, name, created_at, password_hash FROM users WHERE email = $1',
      [email.trim().toLowerCase()],
    );
    return rows[0] ? { ...mapUser(rows[0]), passwordHash: rows[0].password_hash } : null;
  }

  async getUserById(id: string): Promise<User | null> {
    const { rows } = await this.db.query('SELECT id, email, name, created_at FROM users WHERE id = $1', [id]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.query('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
      tokenHash,
      userId,
      expiresAt.toISOString(),
    ]);
  }

  /** Resolves session token hashes to users, ignoring expired/unknown ones. */
  async getSessionUsers(tokenHashes: string[]): Promise<(User & { tokenHash: string })[]> {
    if (tokenHashes.length === 0) return [];
    const { rows } = await this.db.query(
      `SELECT s.token_hash, u.id, u.email, u.name, u.created_at
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ANY($1::text[]) AND s.expires_at > now()`,
      [tokenHashes],
    );
    return rows.map((r) => ({ ...mapUser(r), tokenHash: r.token_hash }));
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash]);
  }

  async deleteExpiredSessions(): Promise<void> {
    await this.db.query('DELETE FROM auth_sessions WHERE expires_at <= now()');
  }

  // ---------- profile (1:1 user) ----------

  async getProfile(userId: string): Promise<Json> {
    const { rows } = await this.db.query('SELECT data FROM profiles WHERE user_id = $1', [userId]);
    if (rows[0]) return rows[0].data;
    const data = defaultProfile();
    await this.saveProfile(userId, data);
    return data;
  }

  async saveProfile(userId: string, data: Json): Promise<Json> {
    const { rows } = await this.db.query(
      `INSERT INTO profiles (user_id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
       RETURNING data`,
      [userId, jsonParam(data)],
    );
    return rows[0].data;
  }

  // ---------- jobs (1:N user), each with exactly one CV + preferences + CSS ----------

  async listJobs(userId: string): Promise<JobSummary[]> {
    const { rows } = await this.db.query(
      `SELECT j.id, j.data, j.created_at, j.updated_at, c.id AS cv_id, length(c.html) AS cv_len
         FROM jobs j JOIN cvs c ON c.job_id = j.id
        WHERE j.user_id = $1 ORDER BY j.created_at ASC`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      cvId: r.cv_id,
      title: String(r.data?.title ?? ''),
      company: String(r.data?.company ?? ''),
      status: String(r.data?.status ?? ''),
      hasCv: Number(r.cv_len) > 0,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    }));
  }

  async getJob(userId: string, jobId: string): Promise<JobRecord> {
    const { rows } = await this.db.query(
      `SELECT j.id, j.data, j.created_at, j.updated_at, c.id AS cv_id
         FROM jobs j JOIN cvs c ON c.job_id = j.id
        WHERE j.user_id = $1 AND j.id = $2`,
      [userId, jobId],
    );
    if (!rows[0]) throw new NotFoundError(`Job ${jobId}`);
    return mapJob(rows[0]);
  }

  async createJob(userId: string, data: Json = {}): Promise<JobRecord> {
    const jobId = randomUUID();
    const cvId = randomUUID();
    const merged = { ...defaultJob(), ...data };
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO jobs (id, user_id, data) VALUES ($1, $2, $3::jsonb) RETURNING id, data, created_at, updated_at`,
        [jobId, userId, jsonParam(merged)],
      );
      await tx.query('INSERT INTO cvs (id, job_id, html) VALUES ($1, $2, $3)', [cvId, jobId, '']);
      await tx.query('INSERT INTO cv_preferences (cv_id, data) VALUES ($1, $2::jsonb)', [
        cvId,
        jsonParam(defaultPreferences()),
      ]);
      await tx.query('INSERT INTO cv_styles (cv_id, css) VALUES ($1, $2)', [cvId, DEFAULT_CSS]);
      return mapJob({ ...rows[0], cv_id: cvId });
    });
  }

  async saveJob(userId: string, jobId: string, data: Json): Promise<JobRecord> {
    const { rows } = await this.db.query(
      `UPDATE jobs SET data = $3::jsonb, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING id`,
      [userId, jobId, jsonParam(data)],
    );
    if (!rows[0]) throw new NotFoundError(`Job ${jobId}`);
    return this.getJob(userId, jobId);
  }

  async deleteJob(userId: string, jobId: string): Promise<void> {
    const { rows } = await this.db.query('DELETE FROM jobs WHERE user_id = $1 AND id = $2 RETURNING id', [
      userId,
      jobId,
    ]);
    if (!rows[0]) throw new NotFoundError(`Job ${jobId}`);
  }

  // ---------- CV (1:1 job), preferences (1:1 CV), CSS (1:1 CV) ----------

  private async cvIdFor(q: Queryable, userId: string, jobId: string): Promise<string> {
    const { rows } = await q.query(
      'SELECT c.id FROM cvs c JOIN jobs j ON j.id = c.job_id WHERE j.user_id = $1 AND j.id = $2',
      [userId, jobId],
    );
    if (!rows[0]) throw new NotFoundError(`Job ${jobId}`);
    return rows[0].id;
  }

  async getCv(userId: string, jobId: string): Promise<CvRecord> {
    const { rows } = await this.db.query(
      `SELECT c.id, c.job_id, c.html, c.updated_at FROM cvs c JOIN jobs j ON j.id = c.job_id
        WHERE j.user_id = $1 AND j.id = $2`,
      [userId, jobId],
    );
    if (!rows[0]) throw new NotFoundError(`Job ${jobId}`);
    return { id: rows[0].id, jobId: rows[0].job_id, html: rows[0].html, updatedAt: iso(rows[0].updated_at) };
  }

  async saveCvHtml(userId: string, jobId: string, html: string): Promise<CvRecord> {
    const cvId = await this.cvIdFor(this.db, userId, jobId);
    await this.db.query('UPDATE cvs SET html = $2, updated_at = now() WHERE id = $1', [cvId, html]);
    return this.getCv(userId, jobId);
  }

  async getCss(userId: string, jobId: string): Promise<string> {
    const cvId = await this.cvIdFor(this.db, userId, jobId);
    const { rows } = await this.db.query('SELECT css FROM cv_styles WHERE cv_id = $1', [cvId]);
    return rows[0]?.css ?? DEFAULT_CSS;
  }

  async saveCss(userId: string, jobId: string, css: string): Promise<string> {
    const cvId = await this.cvIdFor(this.db, userId, jobId);
    await this.db.query(
      `INSERT INTO cv_styles (cv_id, css, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (cv_id) DO UPDATE SET css = EXCLUDED.css, updated_at = now()`,
      [cvId, css],
    );
    return css;
  }

  async getPreferences(userId: string, jobId: string): Promise<Json> {
    const cvId = await this.cvIdFor(this.db, userId, jobId);
    const { rows } = await this.db.query('SELECT data FROM cv_preferences WHERE cv_id = $1', [cvId]);
    return rows[0]?.data ?? defaultPreferences();
  }

  async savePreferences(userId: string, jobId: string, data: Json): Promise<Json> {
    const cvId = await this.cvIdFor(this.db, userId, jobId);
    const { rows } = await this.db.query(
      `INSERT INTO cv_preferences (cv_id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (cv_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now() RETURNING data`,
      [cvId, jsonParam(data)],
    );
    return rows[0].data;
  }

  // ---------- chat sessions (independent) ----------

  async listChats(userId: string): Promise<Omit<ChatRecord, 'data'>[]> {
    const { rows } = await this.db.query(
      'SELECT id, title, created_at, updated_at FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }));
  }

  async createChat(userId: string, title = 'New chat'): Promise<ChatRecord> {
    const { rows } = await this.db.query(
      `INSERT INTO chat_sessions (id, user_id, title, data) VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, title, data, created_at, updated_at`,
      [randomUUID(), userId, title, jsonParam({ messages: [], turns: [], focusJobId: null })],
    );
    return mapChat(rows[0]);
  }

  async getChat(userId: string, chatId: string): Promise<ChatRecord> {
    const { rows } = await this.db.query(
      'SELECT id, title, data, created_at, updated_at FROM chat_sessions WHERE user_id = $1 AND id = $2',
      [userId, chatId],
    );
    if (!rows[0]) throw new NotFoundError(`Chat ${chatId}`);
    return mapChat(rows[0]);
  }

  async saveChat(userId: string, chatId: string, patch: { title?: string; data?: ChatData }): Promise<ChatRecord> {
    const { rows } = await this.db.query(
      `UPDATE chat_sessions
          SET title = COALESCE($3, title), data = COALESCE($4::jsonb, data), updated_at = now()
        WHERE user_id = $1 AND id = $2
        RETURNING id, title, data, created_at, updated_at`,
      [userId, chatId, patch.title ?? null, patch.data ? jsonParam(patch.data) : null],
    );
    if (!rows[0]) throw new NotFoundError(`Chat ${chatId}`);
    return mapChat(rows[0]);
  }

  async deleteChat(userId: string, chatId: string): Promise<void> {
    const { rows } = await this.db.query('DELETE FROM chat_sessions WHERE user_id = $1 AND id = $2 RETURNING id', [
      userId,
      chatId,
    ]);
    if (!rows[0]) throw new NotFoundError(`Chat ${chatId}`);
  }
}

function mapUser(r: any): User {
  return { id: r.id, email: r.email, name: r.name, createdAt: iso(r.created_at) };
}

function mapJob(r: any): JobRecord {
  return { id: r.id, cvId: r.cv_id, data: r.data, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
}

function mapChat(r: any): ChatRecord {
  return { id: r.id, title: r.title, data: r.data ?? {}, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
}
