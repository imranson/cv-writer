import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCv } from '../../src/cv/checks.js';
import { addEntry } from '../../src/domain/profile.js';
import { DEFAULT_STYLE } from '../../src/domain/schemas.js';
import { NotFoundError, Store } from '../../src/storage/store.js';
import { CRITIQUE, CV_DOC, JOB, PROFILE, tempDir } from '../support/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
let store: Store;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  store = new Store(dir);
});
afterEach(() => cleanup());

describe('profile storage', () => {
  it('starts empty and records every change with a full snapshot', async () => {
    expect((await store.getProfile()).revision).toBe(0);
    await store.updateProfile({ operation: 'seed', actor: 'test', payload: {}, apply: () => PROFILE });
    const p2 = await store.updateProfile({
      operation: 'add_entry',
      actor: 'coordinator',
      reason: 'user mentioned a project',
      payload: { title: 'CLI' },
      apply: (p) => addEntry(p, { section: 'project', title: 'CLI' }).profile,
    });
    expect(p2.revision).toBe(2);
    const history = await store.profileHistory();
    expect(history.map((h) => [h.revision, h.operation, h.actor])).toEqual([
      [1, 'seed', 'test'],
      [2, 'add_entry', 'coordinator'],
    ]);
    expect(history[1]!.reason).toBe('user mentioned a project');
    expect(history[0]!.snapshot.entries).toHaveLength(2);
    expect(history[1]!.snapshot.entries).toHaveLength(3);
    expect(JSON.parse(await readFile(path.join(dir, 'profile.json'), 'utf8')).revision).toBe(2);
  });

  it('serialises concurrent updates so none are lost', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.updateProfile({ operation: 'add_facts', actor: 't', payload: {}, apply: (p) => ({ ...p, facts: [...p.facts, `fact ${i}`] }) }),
      ),
    );
    const p = await store.getProfile();
    expect(p.revision).toBe(10);
    expect(p.facts).toHaveLength(10);
  });

  it('reads the profile format written by the previous version of the app', async () => {
    await writeFile(
      path.join(dir, 'profile.json'),
      JSON.stringify({ revision: 4, updatedAt: 'x', contact: { name: 'A', email: 'a@b.c', links: [] }, headline: 'h', entries: [{ id: 'project-1', section: 'project', title: 'T', highlights: [], skills: [] }], skills: [], facts: ['f'] }),
    );
    expect((await store.getProfile()).entries[0]!.id).toBe('project-1');
  });
});

describe('jobs and CV versions', () => {
  it('saves jobs with readable ids and lists newest first', async () => {
    let t = 0;
    const s = new Store(dir, () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)));
    const a = await s.saveJob(JOB);
    const b = await s.saveJob({ ...JOB, company: 'Other Co' });
    expect(a.id).toMatch(/^babbage-systems-platform-engineer-[0-9a-f]{6}$/);
    expect((await s.listJobs()).map((j) => j.id)).toEqual([b.id, a.id]);
    expect((await s.getJob(a.id)).description).toBe(JOB.description);
    const updated = await s.updateJob(a.id, { keywords: ['Go'] });
    expect(updated.keywords).toEqual(['Go']);
    expect(updated.createdAt).toBe(a.createdAt);
  });

  it('rejects unknown and unsafe ids', async () => {
    await expect(store.getJob('../../etc/passwd')).rejects.toThrow(NotFoundError);
    await expect(store.getJob('missing')).rejects.toThrow(NotFoundError);
    await expect(store.getRun('nope')).rejects.toThrow(NotFoundError);
  });

  it('numbers versions, keeps them immutable except for reviews/exports, and skips old formats', async () => {
    const job = await store.saveJob(JOB);
    await mkdir(path.join(dir, 'cvs', job.id), { recursive: true });
    await writeFile(path.join(dir, 'cvs', job.id, 'v001.json'), JSON.stringify({ jobId: job.id, version: 1, document: { name: 'old', contactLine: '' } }));
    const checks = checkCv(CV_DOC, PROFILE);
    const v2 = await store.addCvVersion({ jobId: job.id, profileRevision: 1, writerRunId: 'writer-1', document: CV_DOC, checks });
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('draft');
    const v3 = await store.addCvVersion({ jobId: job.id, profileRevision: 1, basedOnVersion: 2, feedback: 'shorter', writerRunId: 'writer-1', document: CV_DOC, checks });
    expect(v3.version).toBe(3);
    await store.updateCvVersion(job.id, 2, (v) => ({ ...v, critiques: [{ ...CRITIQUE, at: 'now', requestedBy: 'writer', runId: 'critic-1', model: 'm' }] }));
    const list = await store.listCvVersions(job.id);
    expect(list.map((v) => v.version)).toEqual([2, 3]);
    expect(list[0]!.critiques).toHaveLength(1);
    await expect(store.getCvVersion(job.id, 1)).rejects.toThrow(/older version of the app/);
    await expect(store.addCvVersion({ jobId: 'nope', profileRevision: 1, writerRunId: 'w', document: CV_DOC, checks })).rejects.toThrow(NotFoundError);
  });
});

describe('sessions, runs, style and audit', () => {
  it('creates, saves and lists sessions newest first', async () => {
    let t = 0;
    const store = new Store(dir, () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)));
    const a = await store.createSession();
    const b = await store.createSession('job-1');
    await store.saveSession({ ...a, transcript: [{ role: 'user', text: 'Hello there', at: 'x' }] });
    const list = await store.listSessions();
    expect(list[0]!.id).toBe(a.id);
    expect(list[0]!.preview).toBe('Hello there');
    expect((await store.getSession(b.id)).activeJobId).toBe('job-1');
  });

  it('stores agent runs', async () => {
    await store.saveRun({ id: 'writer-abc', agent: 'writer', model: 'm', requestedBy: 'coordinator', jobId: 'j', startedAt: 'x', outcome: 'completed', system: 's', brief: 'b', messages: [], usage: { promptTokens: 1, outputTokens: 2, calls: 1 } });
    expect((await store.getRun('writer-abc')).brief).toBe('b');
  });

  it('defaults the style and validates saves', async () => {
    expect(await store.getStyle()).toEqual(DEFAULT_STYLE);
    await store.setStyle({ ...DEFAULT_STYLE, fontFamily: 'helvetica' });
    expect((await store.getStyle()).fontFamily).toBe('helvetica');
    await expect(store.setStyle({ ...DEFAULT_STYLE, baseFontSize: 99 })).rejects.toThrow();
  });

  it('appends audit records and returns the most recent', async () => {
    for (let i = 0; i < 5; i++) await store.audit({ actor: 'coordinator', action: `a${i}`, outcome: 'ok' });
    const records = await store.readAudit(2);
    expect(records.map((r) => r.action)).toEqual(['a3', 'a4']);
    expect(records[0]!.at).toMatch(/^\d{4}-/);
  });
});
