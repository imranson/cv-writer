import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CV_CSS } from '../../src/cv/defaultStyle.js';
import { jsonStore, textStore } from '../../src/storage/fileStore.js';
import { DATA_DIRS, flattenText, jobTitle, profileTitle, Workspace } from '../../src/storage/workspace.js';
import { tempDir } from '../support/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(() => cleanup());

describe('FileStore', () => {
  it('round-trips JSON and text, lists ids, deletes', async () => {
    const json = jsonStore(path.join(dir, 'things'));
    const text = textStore(path.join(dir, 'pages'), '.html');
    expect(await json.list()).toEqual([]);
    expect(await json.read('missing')).toBeUndefined();
    await json.write('b-1', { a: 1 });
    await json.write('a-1', { b: [2] });
    await text.write('a-1', '<p>hi</p>');
    expect(await json.list()).toEqual(['a-1', 'b-1']);
    expect(await json.read('a-1')).toEqual({ b: [2] });
    expect(await text.read('a-1')).toBe('<p>hi</p>');
    expect(await json.exists('a-1')).toBe(true);
    expect(await json.modifiedAt('a-1')).toBeInstanceOf(Date);
    expect(await json.delete('a-1')).toBe(true);
    expect(await json.delete('a-1')).toBe(false);
    expect(await json.list()).toEqual(['b-1']);
    // no temp files left behind by atomic writes
    expect((await readdir(path.join(dir, 'things'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses ids that could escape the directory', async () => {
    const json = jsonStore(path.join(dir, 'things'));
    await expect(json.write('../evil', {})).rejects.toThrow('Invalid id');
    await expect(json.read('../../etc/passwd')).rejects.toThrow('Invalid id');
  });
});

describe('Workspace data model', () => {
  it('stores each data type in its own directory', async () => {
    const ws = new Workspace(dir);
    const profile = await ws.saveProfile(undefined, { name: 'Ada Lovelace' });
    const job = await ws.saveJob(undefined, String(profile.id), { title: 'Engineer', company: 'Acme' });
    await ws.saveCv(String(job.id), { html: '<h1>Ada</h1>', preferences: { tone: 'formal' } });
    await ws.sessions.write('chat-1', { id: 'chat-1', messages: [] });

    const dirs = (await readdir(dir)).sort();
    expect(dirs).toEqual(Object.values(DATA_DIRS).sort());
    expect(await readdir(path.join(dir, 'profiles'))).toEqual([`${profile.id}.json`]);
    expect(await readdir(path.join(dir, 'jobs'))).toEqual([`${job.id}.json`]);
    expect(await readdir(path.join(dir, 'cvs'))).toEqual([`${job.id}.html`]);
    expect(await readdir(path.join(dir, 'cv-preferences'))).toEqual([`${job.id}.json`]);
    expect(await readdir(path.join(dir, 'cv-styles'))).toEqual([`${job.id}.css`]);
    expect(await readdir(path.join(dir, 'sessions'))).toEqual(['chat-1.json']);
    expect(await readFile(path.join(dir, 'cvs', `${job.id}.html`), 'utf8')).toBe('<h1>Ada</h1>');
  });

  it('profiles are schemaless JSON with id and timestamps', async () => {
    const ws = new Workspace(dir);
    const created = await ws.saveProfile(undefined, { name: 'Ada Lovelace', anything: { goes: [1, 2] }, id: 'ignored' });
    expect(created.id).toMatch(/^profile-ada-lovelace-[0-9a-f]{6}$/);
    expect(created.anything).toEqual({ goes: [1, 2] });
    expect(created.createdAt).toBe(created.updatedAt);
    const replaced = await ws.saveProfile(String(created.id), { name: 'Ada King' });
    expect(replaced.createdAt).toBe(created.createdAt);
    expect(replaced.anything).toBeUndefined();
    const edited = await ws.editProfile(String(created.id), [{ op: 'append', path: 'skills', value: 'Maths' }]);
    expect(edited.skills).toEqual(['Maths']);
    expect(await ws.listProfiles()).toEqual([{ id: created.id, title: 'Ada King', updatedAt: edited.updatedAt }]);
    await expect(ws.editProfile('profile-missing', [])).rejects.toThrow('not found');
  });

  it('a profile has many jobs (1-to-N) and links are not enforced', async () => {
    const ws = new Workspace(dir);
    const p1 = await ws.saveProfile('p1', { name: 'One' });
    await ws.saveJob('j1', 'p1', { title: 'A' });
    await ws.saveJob('j2', 'p1', { title: 'B', company: 'Beta' });
    await ws.saveJob('j3', 'p-unknown', { title: 'C' }); // dangling link is allowed
    expect(p1.id).toBe('p1');
    expect((await ws.listJobs('p1')).map((j) => j.id)).toEqual(['j1', 'j2']);
    expect((await ws.listJobs()).map((j) => j.title)).toEqual(['A', 'B @ Beta', 'C']);
    // editJob keeps the owner
    const edited = await ws.editJob('j1', [{ op: 'set', path: 'status', value: 'applied' }]);
    expect(edited.profileId).toBe('p1');
  });

  it('a job has one CV with one preferences doc and one stylesheet (1-to-1, keyed by job id)', async () => {
    const ws = new Workspace(dir);
    expect(await ws.getCv('j1')).toMatchObject({ exists: false, html: '', css: DEFAULT_CV_CSS, preferences: {} });
    await ws.saveCv('j1', { html: '<h1>Ada</h1>' });
    let cv = await ws.getCv('j1');
    expect(cv).toMatchObject({ exists: true, html: '<h1>Ada</h1>', css: DEFAULT_CV_CSS });
    expect(await ws.cvStyles.read('j1')).toBe(DEFAULT_CV_CSS); // stylesheet materialised so the user can edit it
    cv = await ws.editCv('j1', {
      htmlEdits: [{ find: 'Ada', replace: 'Ada Lovelace' }],
      cssEdits: [{ find: '--accent: #1f4e79;', replace: '--accent: #8b0000;' }],
      preferenceOps: [{ op: 'set', path: 'pages', value: 1 }],
    });
    expect(cv.html).toBe('<h1>Ada Lovelace</h1>');
    expect(cv.css).toContain('--accent: #8b0000;');
    expect(cv.preferences).toEqual({ pages: 1 });
    await expect(ws.saveCv('j1', {})).rejects.toThrow('Nothing to write');
    await expect(ws.editCv('j2', { htmlEdits: [{ find: 'a', replace: 'b' }] })).rejects.toThrow('No CV exists');
  });

  it('searches jobs and CVs by keyword', async () => {
    const ws = new Workspace(dir);
    await ws.saveJob('j1', 'p1', { title: 'TypeScript Engineer', description: 'Node.js services' });
    await ws.saveJob('j2', 'p2', { title: 'Data Analyst', description: 'SQL dashboards' });
    await ws.saveCv('j1', { html: '<h1>Ada</h1><p>Built Node.js APIs</p>', preferences: { emphasis: 'backend' } });
    await ws.saveCv('j2', { html: '<p>SQL reporting</p>' });
    expect((await ws.searchJobs('node.js typescript')).map((h) => h.id)).toEqual(['j1']);
    expect((await ws.searchJobs('sql', { profileId: 'p1' })).map((h) => h.id)).toEqual([]);
    const cvHits = await ws.searchCvs('backend node.js');
    expect(cvHits[0]).toMatchObject({ id: 'j1', title: 'TypeScript Engineer' });
    expect(cvHits[0].snippet).not.toContain('<p>');
  });

  it('derives titles and flattens text for search', () => {
    expect(profileTitle({ basics: { name: 'Ada' } })).toBe('Ada');
    expect(jobTitle({ role: 'Dev', employer: 'Acme' })).toBe('Dev @ Acme');
    expect(flattenText({ id: 'x', a: 'one', b: [2, { c: 'three' }], updatedAt: 'skip' })).toBe('one\n2\nthree');
  });
});
