import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STYLE } from '../../src/cv/styles.ts';
import { NotFoundError, Store } from '../../src/storage/store.ts';
import { hashText } from '../../src/util/text.ts';
import { critiqueInput, CV_HTML, LISTING } from '../support/fixtures.ts';
import { tempDir } from '../support/env.ts';

let dir: string;
let cleanup: () => Promise<void>;
let store: Store;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  store = new Store(dir);
  await store.init();
});
afterEach(() => cleanup());

const newJob = () => store.createJob({ title: 'Senior PM', company: 'Brightwave', listing: LISTING, url: 'https://example.com/job' });

describe('profile', () => {
  it('is empty until written, then round-trips as markdown', async () => {
    expect(await store.readProfile()).toBe('');
    await store.writeProfile('# Alex\n\n');
    expect(await store.readProfile()).toBe('# Alex\n');
    expect(await readFile(path.join(dir, 'profile.md'), 'utf8')).toBe('# Alex\n');
  });
});

describe('jobs', () => {
  it('creates, reads, updates, lists and deletes jobs', async () => {
    const job = await newJob();
    expect(job.id).toMatch(/^brightwave-senior-pm-/);
    expect(await store.getJob(job.id)).toMatchObject({ title: 'Senior PM', company: 'Brightwave', url: 'https://example.com/job', listing: LISTING });

    const updated = await store.updateJob(job.id, { title: 'Lead PM', listing: 'New listing' });
    expect(updated.title).toBe('Lead PM');
    expect(updated.company).toBe('Brightwave');
    expect((await store.getJob(job.id))?.listing).toBe('New listing\n');

    expect((await store.listJobs()).map((j) => j.id)).toEqual([job.id]);
    await store.deleteJob(job.id);
    expect(await store.getJob(job.id)).toBeNull();
    await expect(store.deleteJob(job.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lists jobs newest first with CV and critique status', async () => {
    const a = await newJob();
    const b = await store.createJob({ title: 'Other', company: 'Co', listing: 'x' });
    await store.writeCv(a.id, CV_HTML);
    const cv = (await store.readCv(a.id))!;
    await store.addCritique(a.id, { ...critiqueInput(), score: 88, verdict: 'ready', checks: [], createdAt: 'now', cvHash: hashText(cv) });
    const jobs = await store.listJobs();
    expect(jobs[0]!.id).toBe(a.id); // touched by the CV write
    expect(jobs[0]).toMatchObject({ hasCv: true, score: 88, verdict: 'ready', critiqueStale: false });
    expect(jobs[1]).toMatchObject({ id: b.id, hasCv: false });

    await store.writeCv(a.id, CV_HTML.replace('Alex', 'Alexandra'));
    expect((await store.listJobs()).find((j) => j.id === a.id)?.critiqueStale).toBe(true);
  });

  it('rejects path-traversal ids', async () => {
    await expect(store.getJob('../../etc')).rejects.toThrow(/Invalid job id/);
    await expect(store.getSession('../x')).rejects.toThrow(/Invalid session id/);
  });
});

describe('CVs, versions and styles', () => {
  it('sanitises CVs on write and seeds the default stylesheet', async () => {
    const job = await newJob();
    expect(await store.readCv(job.id)).toBeNull();
    expect(await store.readStyle(job.id)).toBe(DEFAULT_STYLE);
    const saved = await store.writeCv(job.id, '<h1 onclick="x">Alex</h1><script>bad()</script>');
    expect(saved).toBe('<h1>Alex</h1>\n');
    expect(await readFile(path.join(dir, 'jobs', job.id, 'style.css'), 'utf8')).toBe(DEFAULT_STYLE);
  });

  it('keeps a version per change, skips no-op writes and restores versions', async () => {
    const job = await newJob();
    await store.writeCv(job.id, '<h1>One</h1>', 'writer');
    await store.writeCv(job.id, '<h1>One</h1>', 'writer');
    await store.writeCv(job.id, '<h1>Two</h1>', 'user');
    const versions = await store.listCvVersions(job.id);
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.source).sort()).toEqual(['user', 'writer']);
    const first = versions.find((v) => v.source === 'writer')!;
    expect(await store.readCvVersion(job.id, first.id)).toBe('<h1>One</h1>\n');
    expect(await store.restoreCvVersion(job.id, first.id)).toBe('<h1>One</h1>\n');
    expect(await store.readCv(job.id)).toBe('<h1>One</h1>\n');
    expect(await store.listCvVersions(job.id)).toHaveLength(3);
    await expect(store.restoreCvVersion(job.id, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    expect(await store.readCvVersion(job.id, '../../x')).toBeNull();
  });

  it('prunes old versions', async () => {
    const job = await newJob();
    for (let i = 0; i < 45; i++) await store.writeCv(job.id, `<h1>V${i}</h1>`);
    expect((await readdir(path.join(dir, 'jobs', job.id, 'versions'))).length).toBe(40);
  });

  it('stores per-CV CSS and requires an existing job', async () => {
    const job = await newJob();
    await store.writeStyle(job.id, 'body { color: red; }');
    expect(await store.readStyle(job.id)).toBe('body { color: red; }');
    await expect(store.writeStyle('missing-job', 'x')).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.writeCv('missing-job', 'x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('keeps a bounded critique history', async () => {
    const job = await newJob();
    for (let i = 0; i < 25; i++) await store.addCritique(job.id, { ...critiqueInput(), score: i, verdict: 'needs_work', checks: [], createdAt: '', cvHash: '' });
    const all = await store.readCritiques(job.id);
    expect(all).toHaveLength(20);
    expect((await store.latestCritique(job.id))?.score).toBe(24);
  });
});

describe('sessions', () => {
  it('creates, saves, lists and deletes chat sessions', async () => {
    const job = await newJob();
    const s = await store.createSession({ jobId: job.id, contextLimit: 1000 });
    expect(s).toMatchObject({ title: 'New conversation', jobId: job.id, messages: [], contextStart: 0, context: { tokens: 0, limit: 1000, estimated: true } });
    s.messages.push({ id: '1', at: 'now', role: 'user', content: 'Hi' });
    await store.saveSession({ ...s, title: 'Hello' });
    expect((await store.requireSession(s.id)).messages).toHaveLength(1);
    const list = await store.listSessions();
    expect(list).toEqual([expect.objectContaining({ id: s.id, title: 'Hello', messageCount: 1 })]);
    expect(list[0]).not.toHaveProperty('messages');
    await store.deleteSession(s.id);
    expect(await store.getSession(s.id)).toBeNull();
  });

  it('refuses sessions for unknown jobs', async () => {
    await expect(store.createSession({ jobId: 'nope' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
