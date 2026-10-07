import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCv } from '../../src/cv/checks.js';
import type { Store } from '../../src/storage/store.js';
import { CRITIQUE, CV_DOC, PROFILE, seededStore, tempDir } from '../support/fixtures.js';
import { converse, getJson, send, startServer } from '../support/http.js';
import { call, say, ScriptedModel } from '../support/scripted.js';

let dir: string;
let cleanup: () => Promise<void>;
let store: Store;
let jobId: string;
let llm: ScriptedModel;
let server: { url: string; close: () => Promise<void> };
const PDF = Buffer.from('%PDF-1.4 /Type /Page /Type /Page %%EOF');

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  ({ store, jobId } = (await seededStore(dir, { job: true })) as { store: Store; jobId: string });
  await store.addCvVersion({ jobId, profileRevision: 1, writerRunId: 'writer-x', document: CV_DOC, checks: checkCv(CV_DOC, PROFILE) });
  await store.updateCvVersion(jobId, 1, (v) => ({ ...v, critiques: [{ ...CRITIQUE, at: '2026-10-05T10:00:00Z', requestedBy: 'writer', runId: 'critic-x', model: 'critic' }] }));
  const ui = path.join(dir, 'ui');
  await mkdir(path.join(ui, 'assets'), { recursive: true });
  await writeFile(path.join(ui, 'index.html'), '<!doctype html><title>CV Writer</title>');
  await writeFile(path.join(ui, 'assets', 'app.js'), 'console.log(1)');
  llm = new ScriptedModel({});
  server = await startServer({ store, llm, models: { coordinator: 'coord', writer: 'writer', critic: 'critic' }, pdf: async () => PDF, staticDir: ui });
});
afterEach(async () => {
  await server.close();
  await cleanup();
});

describe('read API', () => {
  it('serves config, profile with gaps, history, jobs and versions', async () => {
    const config = await getJson<{ pdfAvailable: boolean; fonts: unknown[]; models: unknown }>(`${server.url}/api/config`);
    expect(config.pdfAvailable).toBe(true);
    expect(config.fonts.length).toBeGreaterThan(10);
    const { profile, gaps } = await getJson<{ profile: { contact: { name: string } }; gaps: string[] }>(`${server.url}/api/profile`);
    expect(profile.contact.name).toBe('Ada Lovelace');
    expect(gaps).toEqual([]);
    const history = await getJson<Array<Record<string, unknown>>>(`${server.url}/api/profile/history`);
    expect(history[0]).toMatchObject({ revision: 1, operation: 'seed' });
    expect(history[0]).not.toHaveProperty('snapshot');
    expect((await getJson<unknown[]>(`${server.url}/api/jobs`))).toHaveLength(1);
    const versions = await getJson<Array<Record<string, unknown>>>(`${server.url}/api/jobs/${jobId}/cvs`);
    expect(versions).toEqual([expect.objectContaining({ version: 1, status: 'draft', score: 78, verdict: 'needs_work', errors: 0 })]);
    const v1 = await getJson<{ document: unknown; currentChecks: { errorCount: number } }>(`${server.url}/api/jobs/${jobId}/cvs/1`);
    expect(v1.document).toEqual(CV_DOC);
    expect(v1.currentChecks.errorCount).toBe(0);
  });

  it('renders HTML with the saved style, Markdown, and PDF on demand', async () => {
    await send('PUT', `${server.url}/api/style`, { fontFamily: 'optima' });
    const html = await (await fetch(`${server.url}/api/jobs/${jobId}/cvs/1/html`)).text();
    expect(html).toContain('Optima');
    const md = await fetch(`${server.url}/api/jobs/${jobId}/cvs/1/markdown`);
    expect(md.headers.get('content-disposition')).toBe('attachment; filename="ada-lovelace-cv-v1.md"');
    const pdf = await fetch(`${server.url}/api/jobs/${jobId}/cvs/1/pdf?download=1`);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('x-page-count')).toBe('2');
    expect(pdf.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('returns 404s and 400s with messages', async () => {
    expect((await fetch(`${server.url}/api/jobs/nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/jobs/${jobId}/cvs/9`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/jobs/${jobId}/cvs/abc`)).status).toBe(400);
    const res = await fetch(`${server.url}/api/nothing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No route for GET /api/nothing' });
  });

  it('serves the audit log and agent runs', async () => {
    await store.audit({ actor: 'coordinator', action: 'add_facts', outcome: 'ok' });
    expect((await getJson<Array<{ action: string }>>(`${server.url}/api/audit?limit=5`))[0]!.action).toBe('add_facts');
    expect((await fetch(`${server.url}/api/runs/writer-missing`)).status).toBe(404);
  });
});

describe('style API', () => {
  it('merges partial updates, applies presets, validates, and audits user changes', async () => {
    let res = await send('PUT', `${server.url}/api/style`, { preset: 'compact', accentColor: '#112233' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ marginVerticalMm: 10, accentColor: '#112233', fontFamily: 'georgia' });
    res = await send('PUT', `${server.url}/api/style`, { baseFontSize: 30 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/baseFontSize/);
    res = await send('PUT', `${server.url}/api/style`, { preset: 'wild' });
    expect(res.status).toBe(400);
    expect((await store.readAudit()).at(-1)).toMatchObject({ actor: 'user', action: 'update_style' });
  });
});

describe('exports', () => {
  it('serves exported files from the output directory only', async () => {
    const out = store.outputDir(jobId);
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'ada-cv-v1.pdf'), PDF);
    const ok = await fetch(`${server.url}/api/jobs/${jobId}/exports/ada-cv-v1.pdf`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/pdf');
    expect((await fetch(`${server.url}/api/jobs/${jobId}/exports/${encodeURIComponent('../../profile.json')}`)).status).toBe(400);
    expect((await fetch(`${server.url}/api/jobs/${jobId}/exports/missing.pdf`)).status).toBe(404);
  });
});

describe('conversation API', () => {
  it('creates sessions on the latest job, opens with a greeting, and streams a turn', async () => {
    const created = (await (await send('POST', `${server.url}/api/sessions`)).json()) as { id: string; activeJobId?: string };
    expect(created.activeJobId).toBe(jobId);
    llm.push('coord', say('Hello Ada! Shall we tackle the Babbage CV?'));
    const opened = await converse(`${server.url}/api/sessions/${created.id}/open`);
    expect(opened.reply).toBe('Hello Ada! Shall we tackle the Babbage CV?');
    expect(opened.events.at(-1)!.event).toBe('done');
    // Opening again does nothing once the conversation has started.
    expect(await (await send('POST', `${server.url}/api/sessions/${created.id}/open`)).json()).toEqual({ skipped: true });

    llm.push('coord', call('add_facts', { facts: ['Fluent French'] }, 'Noted.'), say('Saved that. Anything else?'));
    const turn = await converse(`${server.url}/api/sessions/${created.id}/messages`, { text: 'I speak French fluently' });
    const types = turn.events.map((e) => e.event);
    expect(types).toEqual(expect.arrayContaining(['delta', 'note', 'tool_start', 'tool_end', 'state', 'reply', 'done']));
    expect(turn.reply).toBe('Saved that. Anything else?');

    const session = await getJson<{ transcript: Array<{ role: string; text: string }>; busy: boolean }>(`${server.url}/api/sessions/${created.id}`);
    expect(session.busy).toBe(false);
    expect(session.transcript.map((t) => t.role)).toEqual(['assistant', 'user', 'assistant']);
    const sessions = await getJson<Array<{ id: string; preview: string }>>(`${server.url}/api/sessions`);
    expect(sessions[0]).toMatchObject({ id: created.id, preview: 'I speak French fluently' });
  });

  it('streams errors from the model as an error event and keeps the server healthy', async () => {
    const s = await store.createSession(jobId);
    const turn = await converse(`${server.url}/api/sessions/${s.id}/messages`, { text: 'hi' });
    expect(turn.error).toMatch(/no scripted reply/);
    expect((await fetch(`${server.url}/api/config`)).status).toBe(200);
  });

  it('runs one turn at a time per session', async () => {
    const s = await store.createSession(jobId);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Hold the first turn open until the second request has been refused.
    const slow = llm.chat.bind(llm);
    llm.chat = async () => {
      await gate;
      llm.chat = slow;
      return { message: { role: 'assistant', content: 'first' }, usage: { promptTokens: 0, outputTokens: 0 } };
    };
    const first = converse(`${server.url}/api/sessions/${s.id}/messages`, { text: 'one' });
    await new Promise((r) => setTimeout(r, 50));
    const second = await send('POST', `${server.url}/api/sessions/${s.id}/messages`, { text: 'two' });
    expect(second.status).toBe(409);
    expect((await send('PATCH', `${server.url}/api/sessions/${s.id}`, { activeJobId: jobId })).status).toBe(409);
    release();
    expect((await first).reply).toBe('first');
  });

  it('lets the user pick the active job', async () => {
    const s = await store.createSession();
    const res = await send('PATCH', `${server.url}/api/sessions/${s.id}`, { activeJobId: jobId });
    expect(await res.json()).toEqual({ id: s.id, activeJobId: jobId });
    expect((await send('PATCH', `${server.url}/api/sessions/${s.id}`, { activeJobId: 'nope' })).status).toBe(404);
  });

  it('validates message bodies', async () => {
    const s = await store.createSession();
    expect((await send('POST', `${server.url}/api/sessions/${s.id}/messages`, { text: '  ' })).status).toBe(400);
    const bad = await fetch(`${server.url}/api/sessions/${s.id}/messages`, { method: 'POST', body: '{not json' });
    expect(bad.status).toBe(400);
    expect((await send('POST', `${server.url}/api/sessions/session-nope/messages`, { text: 'x' })).status).toBe(404);
  });

  it('refuses cross-site writes', async () => {
    const res = await send('PUT', `${server.url}/api/style`, { fontFamily: 'arial' }, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    const same = await send('PUT', `${server.url}/api/style`, { fontFamily: 'arial' }, { Origin: server.url });
    expect(same.status).toBe(200);
  });
});

describe('static UI', () => {
  it('serves built files and falls back to index.html, without escaping the folder', async () => {
    expect(await (await fetch(`${server.url}/`)).text()).toContain('<title>CV Writer</title>');
    const js = await fetch(`${server.url}/assets/app.js`);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(await (await fetch(`${server.url}/some/client/route`)).text()).toContain('CV Writer');
    const traversal = await fetch(`${server.url}/..%2f..%2fprofile.json`);
    expect(await traversal.text()).not.toContain('Ada Lovelace');
  });
});
