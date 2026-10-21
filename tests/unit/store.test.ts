import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_DIRS, DEFAULT_CSS, DEFAULT_PREFERENCES, DEFAULT_PROFILE, Store } from '../../src/store';
import { tempDir } from '../helpers';

let tmp: Awaited<ReturnType<typeof tempDir>>;
let store: Store;
beforeEach(async () => {
  tmp = await tempDir();
  store = new Store(tmp.dir);
});
afterEach(() => tmp.cleanup());

describe('users', () => {
  it('creates users with normalised emails and finds them', async () => {
    const user = await store.createUser({ email: ' Ada@Example.COM ', name: 'Ada', passwordHash: 'h' });
    expect(user.email).toBe('ada@example.com');
    expect((await store.findUserByEmail('ADA@example.com'))?.id).toBe(user.id);
    expect(await store.getUser(user.id)).toEqual(user);
  });
  it('rejects duplicate emails', async () => {
    await store.createUser({ email: 'a@b.co', name: 'A', passwordHash: 'h' });
    await expect(store.createUser({ email: 'A@b.co', name: 'B', passwordHash: 'h' })).rejects.toThrow(/already exists/);
  });
  it('validates ids to prevent path traversal', async () => {
    await expect(store.getUser('../etc/passwd')).rejects.toThrow(/Invalid user id/);
    await expect(store.getJob('u1', '../../x')).rejects.toThrow(/Invalid job id/);
  });
});

describe('profile (1 per user)', () => {
  it('returns the default template until saved', async () => {
    expect(await store.getProfile('u1')).toEqual(DEFAULT_PROFILE);
    await store.saveProfile('u1', { name: 'Ada' });
    expect(await store.getProfile('u1')).toEqual({ name: 'Ada' });
  });
  it('rejects non-object profiles', async () => {
    await expect(store.saveProfile('u1', [] as any)).rejects.toThrow(/JSON object/);
  });
});

describe('jobs (1:N) with CV, preferences and CSS (1:1)', () => {
  it('creates a job with its CV, preferences and stylesheet', async () => {
    const job = await store.createJob('u1', { title: 'Engineer', company: 'Acme', description: 'Python' });
    expect(job).toMatchObject({ title: 'Engineer', company: 'Acme', status: 'draft', description: 'Python' });
    expect(await store.getCv('u1', job.id)).toContain('cv-header');
    expect(await store.getPreferences('u1', job.id)).toEqual(DEFAULT_PREFERENCES);
    expect(await store.getCss('u1', job.id)).toBe(DEFAULT_CSS);
  });

  it('ignores client-supplied ids and timestamps', async () => {
    const job = await store.createJob('u1', { id: 'evil', createdAt: '1999', title: 'X' } as any);
    expect(job.id).not.toBe('evil');
    expect(job.createdAt).not.toBe('1999');
  });

  it('lists, updates and replaces jobs', async () => {
    const a = await store.createJob('u1', { title: 'A' });
    const b = await store.createJob('u1', { title: 'B' });
    await store.updateJob('u1', a.id, { company: 'Acme' });
    const list = await store.listJobs('u1');
    expect(list.map((j) => j.id).sort()).toEqual([a.id, b.id].sort());
    expect(list[0].id).toBe(a.id); // most recently updated first
    const replaced = await store.replaceJob('u1', b.id, { title: 'B2' });
    expect(replaced).toMatchObject({ id: b.id, title: 'B2', company: '' });
  });

  it('cascades job deletion to CV, preferences and CSS', async () => {
    const job = await store.createJob('u1', { title: 'A' });
    expect(await store.deleteJob('u1', job.id)).toBe(true);
    for (const kind of ['jobs', 'cvs', 'preferences', 'styles'] as const) {
      expect(await readdir(path.join(tmp.dir, DATA_DIRS[kind], 'u1'))).toEqual([]);
    }
    await expect(store.getCv('u1', job.id)).rejects.toThrow(/not found/);
    expect(await store.deleteJob('u1', job.id)).toBe(false);
  });

  it('saves CV html, preferences and CSS and touches the job', async () => {
    const job = await store.createJob('u1', { title: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    await store.saveCv('u1', job.id, '<h1>Ada</h1>');
    await store.savePreferences('u1', job.id, { ...DEFAULT_PREFERENCES, maxPages: 1 });
    await store.saveCss('u1', job.id, 'h1{color:red}');
    expect(await store.getCv('u1', job.id)).toBe('<h1>Ada</h1>');
    expect((await store.getPreferences('u1', job.id)).maxPages).toBe(1);
    expect(await store.getCss('u1', job.id)).toBe('h1{color:red}');
    expect((await store.getJob('u1', job.id))!.updatedAt > job.updatedAt).toBe(true);
  });

  it('refuses CV operations for unknown jobs', async () => {
    await expect(store.saveCv('u1', 'nojob', 'x')).rejects.toThrow(/not found/);
    await expect(store.getCss('u1', 'nojob')).rejects.toThrow(/not found/);
  });
});

describe('separate directories per data type, partitioned per user', () => {
  it('writes each type to its own directory', async () => {
    const user = await store.createUser({ email: 'a@b.co', name: 'A', passwordHash: 'h' });
    await store.saveProfile(user.id, { name: 'A' });
    const job = await store.createJob(user.id, { title: 'A' });
    const session = await store.createSession(user.id);
    const expected = [
      path.join(DATA_DIRS.users, `${user.id}.json`),
      path.join(DATA_DIRS.profiles, `${user.id}.json`),
      path.join(DATA_DIRS.jobs, user.id, `${job.id}.json`),
      path.join(DATA_DIRS.cvs, user.id, `${job.id}.html`),
      path.join(DATA_DIRS.preferences, user.id, `${job.id}.json`),
      path.join(DATA_DIRS.styles, user.id, `${job.id}.css`),
      path.join(DATA_DIRS.sessions, user.id, `${session.id}.json`),
    ];
    for (const rel of expected) expect(existsSync(path.join(tmp.dir, rel)), rel).toBe(true);
    expect(JSON.parse(await readFile(path.join(tmp.dir, expected[1]), 'utf8'))).toEqual({ name: 'A' });
  });

  it('isolates users from each other', async () => {
    const job = await store.createJob('u1', { title: 'Private' });
    expect(await store.listJobs('u2')).toEqual([]);
    expect(await store.getJob('u2', job.id)).toBeUndefined();
    await expect(store.getCv('u2', job.id)).rejects.toThrow(/not found/);
  });
});

describe('chat sessions (independent)', () => {
  it('creates, lists, saves and deletes sessions', async () => {
    const s = await store.createSession('u1');
    expect(s).toMatchObject({ title: 'New conversation', messages: [], events: [], usage: {} });
    await store.saveSession('u1', { ...s, title: 'Renamed', messages: [{ role: 'user', content: 'hi' }] });
    expect((await store.getSession('u1', s.id))?.messages).toHaveLength(1);
    expect((await store.listSessions('u1'))[0].title).toBe('Renamed');
    expect(await store.deleteSession('u1', s.id)).toBe(true);
    expect(await store.listSessions('u1')).toEqual([]);
  });

  it('survive job deletion', async () => {
    const job = await store.createJob('u1', { title: 'A' });
    const s = await store.createSession('u1');
    await store.deleteJob('u1', job.id);
    expect(await store.getSession('u1', s.id)).toBeDefined();
  });
});
