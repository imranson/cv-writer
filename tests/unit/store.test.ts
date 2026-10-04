import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/cv/render.js';
import { verifyCv } from '../../src/cv/verify.js';
import { mergeSkills } from '../../src/domain/profile.js';
import { assertSafeId, type NewCvVersion } from '../../src/storage/store.js';
import { sampleCv, sampleJob, sampleProfile, tempStore } from '../helpers.js';

function draft(jobId: string, extra: Partial<NewCvVersion> = {}): NewCvVersion {
  const doc = sampleCv();
  return {
    jobId,
    profileRevision: 1,
    changeSummary: 'first draft',
    document: doc,
    markdown: renderMarkdown(doc),
    verification: verifyCv(doc, sampleProfile()),
    ...extra,
  };
}

describe('CvStore profile', () => {
  it('returns an empty profile at revision 0 when nothing is stored', async () => {
    const store = await tempStore();
    expect(await store.getProfile()).toMatchObject({ revision: 0, entries: [], skills: [], facts: [] });
  });

  it('bumps the revision and records a snapshot for every change', async () => {
    const store = await tempStore();
    await store.updateProfile('add_skills', { a: 1 }, (p) => mergeSkills(p, 'Languages', ['Python']));
    const p2 = await store.updateProfile('add_skills', { a: 2 }, (p) => mergeSkills(p, 'Languages', ['Go']));
    expect(p2.revision).toBe(2);
    expect(await store.getProfile()).toEqual(p2);

    const history = await store.profileHistory();
    expect(history.map((h) => [h.revision, h.operation, h.payload])).toEqual([
      [1, 'add_skills', { a: 1 }],
      [2, 'add_skills', { a: 2 }],
    ]);
    expect((await store.getProfileAtRevision(1))?.skills).toEqual([{ category: 'Languages', items: ['Python'] }]);
    expect((await store.getProfileAtRevision(0))?.revision).toBe(0);
    expect(await store.getProfileAtRevision(99)).toBeUndefined();
  });

  it('serialises concurrent updates so none are lost', async () => {
    const store = await tempStore();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.updateProfile('add', i, (p) => mergeSkills(p, 'S', [`skill${i}`]))),
    );
    const profile = await store.getProfile();
    expect(profile.revision).toBe(20);
    expect(profile.skills[0]!.items).toHaveLength(20);
  });

  it('rejects changes that produce an invalid profile and keeps the old state', async () => {
    const store = await tempStore();
    await expect(
      store.updateProfile('bad', {}, (p) => ({ ...p, entries: [{ id: 1 } as never] })),
    ).rejects.toThrow();
    expect((await store.getProfile()).revision).toBe(0);
    await expect(store.updateProfile('ok', {}, (p) => p)).resolves.toMatchObject({ revision: 1 });
  });
});

describe('CvStore jobs', () => {
  it('saves a job with a readable id and lists jobs in creation order', async () => {
    const store = await tempStore();
    const first = await store.saveJob(sampleJob());
    const second = await store.saveJob({ ...sampleJob(), company: 'Zeta Ltd', title: 'Data Engineer' });
    expect(first.id).toBe('acme-health-graduate-software-engineer-id1');
    expect(first).toMatchObject({ requirements: sampleJob().requirements, createdAt: '2026-10-04T12:00:00.000Z' });
    expect(await store.getJob(first.id)).toEqual(first);
    expect((await store.listJobs()).map((j) => j.id)).toEqual([first.id, second.id]);
    expect(await store.getJob('missing-job')).toBeUndefined();
  });

  it('validates job input', async () => {
    const store = await tempStore();
    await expect(store.saveJob({ ...sampleJob(), description: '' })).rejects.toThrow();
  });
});

describe('CvStore CV versions', () => {
  it('numbers versions per job and returns the latest by default', async () => {
    const store = await tempStore();
    const v1 = await store.saveCvVersion(draft('job-a'));
    const v2 = await store.saveCvVersion(draft('job-a', { basedOnVersion: 1, feedback: 'shorter' }));
    const other = await store.saveCvVersion(draft('job-b'));
    expect([v1.version, v2.version, other.version]).toEqual([1, 2, 1]);
    expect(v2).toMatchObject({ status: 'draft', basedOnVersion: 1, feedback: 'shorter' });
    expect((await store.getCvVersion('job-a'))?.version).toBe(2);
    expect((await store.getCvVersion('job-a', 1))?.changeSummary).toBe('first draft');
    expect(await store.getCvVersion('job-a', 7)).toBeUndefined();
    expect((await store.listCvVersions('job-a')).map((v) => v.version)).toEqual([1, 2]);
    expect(await store.listCvVersions('job-none')).toEqual([]);
  });

  it('keeps versions in numeric order past 9', async () => {
    const store = await tempStore();
    for (let i = 0; i < 11; i++) await store.saveCvVersion(draft('job-a'));
    expect((await store.listCvVersions('job-a')).map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('approves a version and records its exports', async () => {
    const store = await tempStore();
    await store.saveCvVersion(draft('job-a'));
    const approved = await store.approveCvVersion('job-a', 1, { markdown: 'a.md', html: 'a.html' });
    expect(approved).toMatchObject({ status: 'approved', exports: { markdown: 'a.md', html: 'a.html' } });
    expect(approved.approvedAt).toBeDefined();
    await expect(store.approveCvVersion('job-a', 2, { markdown: '', html: '' })).rejects.toThrow(/No CV version 2/);
  });

  it('stores versions as readable JSON files', async () => {
    const store = await tempStore();
    await store.saveCvVersion(draft('job-a'));
    const raw = JSON.parse(await readFile(path.join(store.root, 'cvs', 'job-a', 'v001.json'), 'utf8'));
    expect(raw.markdown).toContain('# Alex Morgan');
  });
});

describe('CvStore audit + ids', () => {
  it('appends audit events with timestamps', async () => {
    const store = await tempStore();
    await store.audit({ actor: 'coordinator', action: 'x', ok: true });
    await store.audit({ actor: 'cv-writer', action: 'y', ok: false, detail: { error: 'e' } });
    const events = await store.readAudit();
    expect(events.map((e) => [e.actor, e.action, e.ok])).toEqual([
      ['coordinator', 'x', true],
      ['cv-writer', 'y', false],
    ]);
    expect(events[0]!.at).toMatch(/^2026-10-04T/);
  });

  it('rejects ids that could escape the data directory', async () => {
    const store = await tempStore();
    for (const bad of ['../etc', 'a/b', 'UPPER', '', '-lead']) expect(() => assertSafeId(bad, 'job')).toThrow();
    await expect(store.getJob('../../secret')).rejects.toThrow(/Invalid job id/);
    await expect(store.saveCvVersion(draft('../x'))).rejects.toThrow(/Invalid job id/);
  });
});
