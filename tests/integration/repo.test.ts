import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/index.js';
import { migrate, MIGRATIONS } from '../../src/db/schema.js';
import { createRepo, DuplicateEmailError, type Repo } from '../../src/db/repo.js';
import { DEFAULT_CSS, DEFAULT_PREFERENCES } from '../../src/cv/defaults.js';

let db: Db;
let repo: Repo;

beforeAll(async () => {
  db = await createDb({});
  await migrate(db);
  repo = createRepo(db);
});
afterAll(() => db.close());

describe('PostgreSQL schema & migrations', () => {
  it('is idempotent', async () => {
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
    expect(rows.map((r) => Number(r.version))).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('enforces JSON object documents', async () => {
    const u = await repo.createUser({ email: 'chk@example.com', name: '', passwordHash: 'x' });
    await expect(db.query(`UPDATE profiles SET data = '[1,2]'::jsonb WHERE user_id = $1`, [u.id])).rejects.toThrow(/profiles_data_object/);
  });
});

describe('data model: user 1─1 profile 1─N jobs 1─1 CV 1─1 preferences / CSS; chat sessions independent', () => {
  it('creates exactly one profile per user (seeded with the name)', async () => {
    const u = await repo.createUser({ email: 'One@Example.com', name: 'One', passwordHash: 'h' });
    expect(u.email).toBe('one@example.com');
    expect(await repo.getProfile(u.id)).toEqual({ name: 'One' });
    await expect(repo.createUser({ email: 'one@example.com', name: '', passwordHash: 'h' })).rejects.toBeInstanceOf(DuplicateEmailError);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM profiles WHERE user_id = $1', [u.id]);
    expect(rows[0]).toEqual({ n: 1 });
    expect(await repo.saveProfile(u.id, { name: 'One', skills: ['SQL'] })).toEqual({ name: 'One', skills: ['SQL'] });
  });

  it('creates a CV with default preferences and stylesheet for every job', async () => {
    const u = await repo.createUser({ email: 'jobs@example.com', name: '', passwordHash: 'h' });
    const a = await repo.createJob(u.id, { title: 'Engineer', company: 'Acme' });
    const b = await repo.createJob(u.id, { role: 'Analyst', employer: 'Globex' });
    const list = await repo.listJobs(u.id);
    expect(list.map((j) => [j.title, j.company])).toEqual([
      ['Engineer', 'Acme'],
      ['Analyst', 'Globex'],
    ]);
    const cv = await repo.getCv(u.id, a.id);
    expect(cv).toMatchObject({ jobId: a.id, cvId: a.cvId, html: '', css: DEFAULT_CSS, preferences: DEFAULT_PREFERENCES });
    expect(a.cvId).not.toBe(b.cvId);
    await expect(db.query('INSERT INTO cvs (job_id) VALUES ($1)', [a.id])).rejects.toThrow(/unique|duplicate/i);
  });

  it('updates CV HTML, CSS and preferences independently', async () => {
    const u = await repo.createUser({ email: 'cv@example.com', name: '', passwordHash: 'h' });
    const job = await repo.createJob(u.id, { title: 'X' });
    expect(await repo.saveCvHtml(u.id, job.id, '<h1>Me</h1>')).toBe(true);
    expect(await repo.saveCss(u.id, job.id, 'h1{}')).toBe(true);
    expect(await repo.savePreferences(u.id, job.id, { maxPages: 1 })).toBe(true);
    expect(await repo.getCv(u.id, job.id)).toMatchObject({ html: '<h1>Me</h1>', css: 'h1{}', preferences: { maxPages: 1 } });
    expect((await repo.listJobs(u.id))[0].cvChars).toBe(11);
  });

  it('cascades job deletion to CV, preferences and CSS', async () => {
    const u = await repo.createUser({ email: 'del@example.com', name: '', passwordHash: 'h' });
    const job = await repo.createJob(u.id, { title: 'Gone' });
    expect(await repo.deleteJob(u.id, job.id)).toBe(true);
    for (const table of ['cvs', 'cv_preferences', 'cv_styles']) {
      const col = table === 'cvs' ? 'id' : 'cv_id';
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [job.cvId]);
      expect(rows[0]).toEqual({ n: 0 });
    }
  });

  it('isolates every record by user', async () => {
    const alice = await repo.createUser({ email: 'alice@example.com', name: '', passwordHash: 'h' });
    const bob = await repo.createUser({ email: 'bob@example.com', name: '', passwordHash: 'h' });
    const job = await repo.createJob(alice.id, { title: 'Secret' });
    const session = await repo.createChatSession(alice.id);
    expect(await repo.getJob(bob.id, job.id)).toBeNull();
    expect(await repo.getCv(bob.id, job.id)).toBeNull();
    expect(await repo.saveCvHtml(bob.id, job.id, 'hack')).toBe(false);
    expect(await repo.saveCss(bob.id, job.id, 'hack')).toBe(false);
    expect(await repo.savePreferences(bob.id, job.id, {})).toBe(false);
    expect(await repo.saveJob(bob.id, job.id, {})).toBeNull();
    expect(await repo.deleteJob(bob.id, job.id)).toBe(false);
    expect(await repo.getChatSession(bob.id, session.id)).toBeNull();
    expect(await repo.listJobs(bob.id)).toEqual([]);
    expect(await repo.getJob(alice.id, 'not-a-uuid')).toBeNull();
  });

  it('stores chat sessions as JSON independent of jobs', async () => {
    const u = await repo.createUser({ email: 'chat@example.com', name: '', passwordHash: 'h' });
    const s = await repo.createChatSession(u.id);
    expect(s).toMatchObject({ title: 'New chat', data: { messages: [], activity: [] } });
    await repo.saveChatSession(u.id, s.id, { title: 'Renamed', data: { messages: [{ role: 'user', content: 'hi' }], activity: [{ type: 'done' }] } });
    const loaded = await repo.getChatSession(u.id, s.id);
    expect(loaded).toMatchObject({ title: 'Renamed', data: { messages: [{ role: 'user', content: 'hi' }], activity: [{ type: 'done' }] } });
    expect((await repo.listChatSessions(u.id)).map((x) => x.id)).toEqual([s.id]);
    expect(await repo.deleteChatSession(u.id, s.id)).toBe(true);
  });

  it('manages auth sessions with expiry', async () => {
    const u = await repo.createUser({ email: 'sess@example.com', name: '', passwordHash: 'h' });
    await repo.createAuthSession(u.id, 'live', new Date(Date.now() + 60_000));
    await repo.createAuthSession(u.id, 'old', new Date(Date.now() - 60_000));
    expect((await repo.getUserBySessionHash('live'))?.id).toBe(u.id);
    expect(await repo.getUserBySessionHash('old')).toBeNull();
    await repo.purgeExpiredSessions();
    await repo.deleteAuthSession('live');
    expect(await repo.getUserBySessionHash('live')).toBeNull();
  });
});
