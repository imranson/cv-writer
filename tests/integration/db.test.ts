import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/index.js';
import { migrate, splitSql } from '../../src/db/migrate.js';
import { DEFAULT_CSS } from '../../src/db/defaults.js';
import { NotFoundError, Repo } from '../../src/db/repo.js';
import { createTestDb } from '../helpers.js';

let db: Db;
let repo: Repo;
let ada: { id: string };
let bob: { id: string };

beforeAll(async () => {
  ({ db, repo } = await createTestDb());
  ada = await repo.createUser({ email: 'Ada@Example.com ', name: 'Ada', passwordHash: 'h' });
  bob = await repo.createUser({ email: 'bob@example.com', name: 'Bob', passwordHash: 'h' });
});
afterAll(() => db.close());

describe('migrations', () => {
  it('are idempotent', async () => {
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query('SELECT version FROM schema_migrations');
    expect(rows.map((r) => r.version)).toEqual([1]);
  });
  it('splitSql strips comments and empty statements', () => {
    expect(splitSql('-- c\nSELECT 1;\n\n;SELECT 2; -- x')).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('users & sessions', () => {
  it('normalises emails and creates a default profile (1:1)', async () => {
    const u = await repo.getUserByEmail('ADA@example.com');
    expect(u?.email).toBe('ada@example.com');
    const profile = await repo.getProfile(ada.id);
    expect(profile.basics).toMatchObject({ name: 'Ada', email: 'ada@example.com' });
  });

  it('rejects duplicate emails', async () => {
    await expect(repo.createUser({ email: 'ada@example.com', name: 'x', passwordHash: 'h' })).rejects.toThrow(/unique|duplicate/i);
  });

  it('resolves only unexpired sessions', async () => {
    await repo.createSession(ada.id, 'live-hash', new Date(Date.now() + 60_000));
    await repo.createSession(ada.id, 'dead-hash', new Date(Date.now() - 60_000));
    const users = await repo.getSessionUsers(['live-hash', 'dead-hash', 'unknown']);
    expect(users.map((u) => u.tokenHash)).toEqual(['live-hash']);
    await repo.deleteExpiredSessions();
    await repo.deleteSession('live-hash');
    expect(await repo.getSessionUsers(['live-hash'])).toEqual([]);
    expect(await repo.getSessionUsers([])).toEqual([]);
  });
});

describe('data model: profile 1—N jobs, job 1—1 CV, CV 1—1 preferences & CSS', () => {
  it('creating a job creates its CV, preferences and stylesheet', async () => {
    const job = await repo.createJob(ada.id, { title: 'Engineer', company: 'Acme' });
    expect(job.data).toMatchObject({ title: 'Engineer', company: 'Acme', status: 'draft', requirements: [] });
    const cv = await repo.getCv(ada.id, job.id);
    expect(cv).toMatchObject({ id: job.cvId, jobId: job.id, html: '' });
    expect(await repo.getCss(ada.id, job.id)).toBe(DEFAULT_CSS);
    expect(await repo.getPreferences(ada.id, job.id)).toMatchObject({ pageSize: 'A4', maxPages: 2 });
  });

  it('supports many jobs per user, each with exactly one CV', async () => {
    const second = await repo.createJob(ada.id, { title: 'Lead' });
    const jobs = await repo.listJobs(ada.id);
    expect(jobs.map((j) => j.title)).toEqual(['Engineer', 'Lead']);
    expect(new Set(jobs.map((j) => j.cvId)).size).toBe(2);
    await expect(db.query('INSERT INTO cvs (id, job_id) VALUES ($1, $2)', ['dup', second.id])).rejects.toThrow(/unique|duplicate/i);
  });

  it('saves CV HTML, CSS, preferences and job data', async () => {
    const [job] = await repo.listJobs(ada.id);
    await repo.saveCvHtml(ada.id, job.id, '<h1>Ada</h1>');
    await repo.saveCss(ada.id, job.id, 'h1{}');
    await repo.savePreferences(ada.id, job.id, { pageSize: 'Letter' });
    await repo.saveJob(ada.id, job.id, { title: 'Senior Engineer' });
    expect((await repo.getCv(ada.id, job.id)).html).toBe('<h1>Ada</h1>');
    expect(await repo.getCss(ada.id, job.id)).toBe('h1{}');
    expect(await repo.getPreferences(ada.id, job.id)).toEqual({ pageSize: 'Letter' });
    expect((await repo.getJob(ada.id, job.id)).data).toEqual({ title: 'Senior Engineer' });
    expect((await repo.listJobs(ada.id))[0].hasCv).toBe(true);
  });

  it('deleting a job cascades to its CV, preferences and CSS', async () => {
    const job = await repo.createJob(ada.id, { title: 'Temp' });
    await repo.deleteJob(ada.id, job.id);
    for (const table of ['cvs', 'cv_preferences', 'cv_styles']) {
      const col = table === 'cvs' ? 'id' : 'cv_id';
      const { rows } = await db.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [job.cvId]);
      expect(rows).toHaveLength(0);
    }
    await expect(repo.deleteJob(ada.id, job.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('isolates users: nobody can read or write another account’s data', async () => {
    const [adaJob] = await repo.listJobs(ada.id);
    expect(await repo.listJobs(bob.id)).toEqual([]);
    await expect(repo.getJob(bob.id, adaJob.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.getCv(bob.id, adaJob.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.saveCvHtml(bob.id, adaJob.id, 'pwned')).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.saveCss(bob.id, adaJob.id, 'pwned')).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.savePreferences(bob.id, adaJob.id, {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.saveJob(bob.id, adaJob.id, {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.deleteJob(bob.id, adaJob.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await repo.getCv(ada.id, adaJob.id)).html).toBe('<h1>Ada</h1>');
  });
});

describe('chat sessions (independent JSON)', () => {
  it('CRUD and isolation', async () => {
    const chat = await repo.createChat(ada.id);
    expect(chat).toMatchObject({ title: 'New chat', data: { messages: [], turns: [], focusJobId: null } });
    const saved = await repo.saveChat(ada.id, chat.id, { title: 'Renamed', data: { messages: [{ role: 'user', content: 'hi' }], turns: [] } });
    expect(saved.title).toBe('Renamed');
    expect(saved.data.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect((await repo.saveChat(ada.id, chat.id, { title: 'Only title' })).data.messages).toHaveLength(1);
    expect((await repo.listChats(ada.id)).map((c) => c.id)).toContain(chat.id);
    await expect(repo.getChat(bob.id, chat.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.deleteChat(bob.id, chat.id)).rejects.toBeInstanceOf(NotFoundError);
    await repo.deleteChat(ada.id, chat.id);
    await expect(repo.getChat(ada.id, chat.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleting a user cascades everything', async () => {
    const tmp = await repo.createUser({ email: 'tmp@example.com', name: 'T', passwordHash: 'h' });
    await repo.createJob(tmp.id, {});
    await repo.createChat(tmp.id);
    await db.query('DELETE FROM users WHERE id = $1', [tmp.id]);
    const { rows } = await db.query(
      `SELECT (SELECT count(*) FROM jobs WHERE user_id = $1) AS j, (SELECT count(*) FROM chat_sessions WHERE user_id = $1) AS c, (SELECT count(*) FROM profiles WHERE user_id = $1) AS p`,
      [tmp.id],
    );
    expect(rows[0]).toEqual({ j: 0, c: 0, p: 0 });
  });
});
