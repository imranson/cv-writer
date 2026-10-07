import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, Tool } from '../../src/agents/agent.js';
import { coordinatorState, coordinatorTools, OPENING_NOTE, pastedText, runTurn, type AppDeps, type TurnContext } from '../../src/agents/coordinator.js';
import { checkCv } from '../../src/cv/checks.js';
import type { Session } from '../../src/domain/schemas.js';
import type { Store } from '../../src/storage/store.js';
import { CRITIQUE, CV_DOC, JOB, LISTING, PROFILE, seededStore, tempDir } from '../support/fixtures.js';
import { call, say, ScriptedModel } from '../support/scripted.js';

let cleanup: () => Promise<void>;
let store: Store;
let llm: ScriptedModel;
let deps: AppDeps;
let events: AgentEvent[];
let session: Session;
let ctx: TurnContext;

const FAKE_PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF');

beforeEach(async () => {
  const t = await tempDir();
  cleanup = t.cleanup;
  ({ store } = await seededStore(t.dir));
  llm = new ScriptedModel({});
  events = [];
  deps = {
    store,
    llm,
    models: { coordinator: 'coord', writer: 'writer', critic: 'critic' },
    pdf: async () => FAKE_PDF,
    fetchPage: async (url) => ({ url, title: 'Platform Engineer', company: 'Babbage Systems', text: LISTING }),
  };
  session = await store.createSession();
  ctx = { session, emit: (e) => events.push(e), fetched: new Map() };
});
afterEach(() => cleanup());

function tool(name: string): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const t = coordinatorTools(deps, ctx).find((x) => x.name === name) as Tool | undefined;
  if (!t) throw new Error(`no tool ${name}`);
  return async (args) => {
    const parsed = t.schema.parse(args);
    return (await (t.run as (a: unknown) => Promise<unknown>)(parsed)) as Record<string, unknown>;
  };
}

async function withJob(): Promise<string> {
  const job = await store.saveJob(JOB);
  ctx.session.activeJobId = job.id;
  return job.id;
}

async function withVersion(jobId: string, critique = true): Promise<void> {
  await store.addCvVersion({ jobId, profileRevision: 1, writerRunId: 'writer-x', document: CV_DOC, checks: checkCv(CV_DOC, PROFILE) });
  if (critique) await store.updateCvVersion(jobId, 1, (v) => ({ ...v, critiques: [{ ...CRITIQUE, at: 'now', requestedBy: 'coordinator', runId: 'c', model: 'critic' }] }));
}

describe('coordinator profile tools', () => {
  it('edits the profile through the history, with the reason, and tells the UI', async () => {
    const r = await tool('add_profile_entry')({ section: 'project', title: 'Infra CLI', highlights: ['Wrote it in Go'], skills: ['Go'], reason: 'user described a side project' });
    expect(r.id).toMatch(/^project-/);
    await tool('update_profile_entry')({ id: r.id, addHighlights: ['Used by 12 teams'] });
    await tool('update_contact')({ phone: '+44 1234' });
    await tool('set_career_goal')({ headline: 'Platform engineering' });
    await tool('add_skills')({ category: 'Infra', items: ['Terraform'] });
    await tool('remove_skills')({ items: ['SQL'] });
    await tool('add_facts')({ facts: ['Prefers hybrid'] });
    await tool('remove_facts')({ facts: [1] });
    await tool('remove_profile_entry')({ id: r.id });
    const history = await store.profileHistory();
    expect(history.map((h) => h.operation)).toEqual(['seed', 'add_entry', 'update_entry', 'update_contact', 'set_career_goal', 'add_skills', 'remove_skills', 'add_facts', 'remove_facts', 'remove_entry']);
    expect(history[1]).toMatchObject({ actor: 'coordinator', reason: 'user described a side project' });
    expect(history[2]!.snapshot.entries.find((e) => e.id === r.id)!.highlights).toEqual(['Wrote it in Go', 'Used by 12 teams']);
    const p = await store.getProfile();
    expect(p.contact.phone).toBe('+44 1234');
    expect(p.facts).toEqual(['Prefers hybrid']);
    expect(events).toContainEqual({ type: 'state', changed: ['profile'] });
  });

  it('turns profile rule violations into errors the model can act on', async () => {
    await expect(tool('update_profile_entry')({ id: 'experience-nope' })).rejects.toThrow(/Known ids/);
    await expect(tool('remove_facts')({ facts: ['not there'] })).rejects.toThrow(/not found/);
  });
});

describe('coordinator job tools', () => {
  it('saves a pasted listing verbatim from the user’s message and makes it active', async () => {
    ctx.session.transcript.push({ role: 'user', text: 'Here is the job', at: 'x' }, { role: 'user', text: LISTING, at: 'x' }, { role: 'user', text: 'thanks', at: 'x' });
    const r = await tool('save_job_listing')({ title: 'Platform Engineer', company: 'Babbage Systems', requirements: ['AWS'], keywords: ['AWS'] });
    expect(r.active).toBe(true);
    const job = await store.getJob(String(r.jobId));
    expect(job.description).toBe(LISTING);
    expect(ctx.session.activeJobId).toBe(job.id);
  });

  it('refuses to save a listing that was never pasted', async () => {
    ctx.session.transcript.push({ role: 'user', text: 'I want a CV for Babbage', at: 'x' });
    await expect(tool('save_job_listing')({ title: 'T', company: 'C', requirements: [], keywords: [] })).rejects.toThrow(/paste the full listing/);
  });

  it('fetches a listing URL and stores the fetched page verbatim', async () => {
    const page = await tool('fetch_job_listing')({ url: 'https://jobs.example/1' });
    expect(page.company).toBe('Babbage Systems');
    const r = await tool('save_job_listing')({ title: 'Platform Engineer', company: 'Babbage Systems', url: 'https://jobs.example/1', listing_source: 'url', requirements: [], keywords: [] });
    expect((await store.getJob(String(r.jobId))).description).toBe(LISTING);
    deps.fetchPage = async () => {
      throw new Error('HTTP 403');
    };
    await expect(tool('fetch_job_listing')({ url: 'https://x' })).rejects.toThrow(/Could not fetch the page: HTTP 403/);
  });

  it('switches and refines the active job', async () => {
    const id = (await store.saveJob(JOB)).id;
    await expect(tool('update_job_listing')({ keywords: ['Go'] })).rejects.toThrow(/No active job/);
    await tool('set_active_job')({ jobId: id });
    expect(ctx.session.activeJobId).toBe(id);
    await tool('update_job_listing')({ keywords: ['Go'] });
    expect((await store.getJob(id)).keywords).toEqual(['Go']);
    await expect(tool('set_active_job')({ jobId: 'nope' })).rejects.toThrow(/Unknown job/);
  });

  it('finds the pasted listing among recent messages', () => {
    expect(pastedText({ ...session, transcript: [] })).toBeUndefined();
    expect(pastedText({ ...session, transcript: [{ role: 'user', text: 'long '.repeat(100), at: '' }, { role: 'assistant', text: 'x'.repeat(9999), at: '' }, { role: 'user', text: 'ok', at: '' }] })).toMatch(/^long/);
  });
});

describe('coordinator CV tools', () => {
  it('runs the writer (which runs the critic) and summarises the result', async () => {
    await withJob();
    llm.push('writer', call('save_cv', { document: CV_DOC, changeSummary: 'draft' }), call('request_critique', { version: 1 }), say('v1 final. Ask about Terraform.'));
    llm.push('critic', call('submit_review', { ...CRITIQUE }), say('done'));
    const r = await tool('write_cv')({ instructions: 'Lead with AWS', user_feedback: 'I love AWS' });
    expect(r).toMatchObject({ versionsSaved: [1], latestVersion: 1, writerNotes: 'v1 final. Ask about Terraform.' });
    expect(String(r.review)).toMatch(/Score 78\/100/);
    expect(events.some((e) => e.type === 'activity' && e.agent === 'writer')).toBe(true);
    expect(events.some((e) => e.type === 'activity' && e.agent === 'critic')).toBe(true);
  });

  it('runs the writer at most once per turn, so the user stays in the loop', async () => {
    await withJob();
    llm.push('writer', call('save_cv', { document: CV_DOC, changeSummary: 'draft' }), call('request_critique', { version: 1 }), say('done'));
    llm.push('critic', call('submit_review', { ...CRITIQUE }), say('done'));
    await tool('write_cv')({ instructions: 'Draft' });
    await expect(tool('write_cv')({ instructions: 'Again', base_version: 1 })).rejects.toThrow(/already run the writer this turn/);
  });

  it('checks the base version exists before calling the writer', async () => {
    await withJob();
    await expect(tool('write_cv')({ instructions: 'x', base_version: 4 })).rejects.toThrow(/No CV version 4/);
    expect(llm.requests).toHaveLength(0);
  });

  it('asks the critic for a review on request and shows a version in full', async () => {
    const jobId = await withJob();
    await withVersion(jobId, false);
    llm.push('critic', call('submit_review', { ...CRITIQUE }), say('done'));
    const r = await tool('critique_cv')({ version: 1 });
    expect(String(r.review)).toMatch(/needs_work/);
    expect((await store.getCvVersion(jobId, 1)).critiques[0]!.requestedBy).toBe('coordinator');
    const shown = await tool('show_cv_version')({ version: '1' });
    expect(shown.document).toEqual(CV_DOC);
    expect(shown.reviews).toHaveLength(1);
  });

  it('refuses approval with check errors, without a review, or with critical issues', async () => {
    const jobId = await withJob();
    await withVersion(jobId, false);
    await expect(tool('approve_cv')({ version: 1 })).rejects.toThrow(/has not been reviewed/);
    await store.updateCvVersion(jobId, 1, (v) => ({ ...v, critiques: [{ ...CRITIQUE, issues: [{ severity: 'critical', category: 'factual', problem: 'Invented award' }], at: 'n', requestedBy: 'writer', runId: 'c', model: 'm' }] }));
    await expect(tool('approve_cv')({ version: 1 })).rejects.toThrow(/critical review issues[\s\S]*Invented award/);
    // The profile changes underneath the CV: the cited entry disappears.
    await store.updateProfile({ operation: 'x', actor: 't', payload: {}, apply: (p) => ({ ...p, entries: p.entries.filter((e) => e.id !== 'education-bbb222') }) });
    await expect(tool('approve_cv')({ version: 1 })).rejects.toThrow(/check error/);
  });

  it('approves a sound version and exports the PDF with the current style', async () => {
    const jobId = await withJob();
    await withVersion(jobId);
    await tool('update_style')({ preset: 'classic', baseFontSize: 10 });
    const r = await tool('approve_cv')({ version: 1 });
    expect(r.approved).toBe('v1');
    const cv = await store.getCvVersion(jobId, 1);
    expect(cv.status).toBe('approved');
    expect(cv.exports[0]).toMatchObject({ pages: 1, style: { fontFamily: 'garamond', baseFontSize: 10 } });
    expect(cv.exports[0]!.pdf).toMatch(/ada-lovelace-cv-v1\.pdf$/);
  });

  it('validates style changes', async () => {
    await expect(tool('update_style')({ accentColor: 'blue' })).rejects.toThrow();
    const r = await tool('update_style')({ fontFamily: 'helvetica', marginVerticalMm: 10 });
    expect(String(r.style)).toMatch(/^Helvetica Neue .*margins 10\/17 mm/);
    expect(events).toContainEqual({ type: 'state', changed: ['style'] });
  });

  it('exports without approving', async () => {
    const jobId = await withJob();
    await withVersion(jobId);
    const r = await tool('export_cv')({ version: 1 });
    expect(r.ok).toBe(true);
    expect((await store.getCvVersion(jobId, 1)).status).toBe('draft');
  });
});

describe('coordinator state', () => {
  it('shows the profile, gaps, jobs, the active listing, versions, checks, review and style', async () => {
    const jobId = await withJob();
    await withVersion(jobId);
    const state = await coordinatorState(deps, ctx.session, new Date('2026-10-05T12:00:00Z'));
    expect(state).toContain('Today is 2026-10-05');
    expect(state).toContain('## Profile (revision 1)');
    expect(state).toContain('"id":"experience-aaa111"');
    expect(state).toContain(`[ACTIVE] ${jobId}`);
    expect(state).toContain('Key requirements:\n- Python or Go');
    expect(state).toContain('Listing text:\n"""\nPlatform Engineer — Babbage Systems');
    expect(state).toMatch(/- v1 \(draft.*critic 78\/100 needs_work/);
    expect(state).toContain('## Latest critic review (v1)');
    expect(state).toContain('PDF export: available');
  });

  it('lists gaps for a new user', async () => {
    const t = await tempDir();
    const fresh = { ...deps, store: new (store.constructor as typeof Store)(t.dir), pdf: undefined };
    const state = await coordinatorState(fresh, ctx.session);
    expect(state).toContain('- Full name is missing.');
    expect(state).toContain('- none yet');
    expect(state).toContain('PDF export: unavailable');
    await t.cleanup();
  });
});

describe('runTurn', () => {
  it('runs a turn, streams, saves the transcript and the model history', async () => {
    llm.push('coord', call('add_facts', { facts: ['Speaks French'] }, 'Noting that.'), say('Saved. What is your notice period?'));
    const streamed: AgentEvent[] = [];
    const { reply, session: s } = await runTurn(deps, session.id, { text: 'I speak French' }, (e) => streamed.push(e));
    expect(reply).toBe('Saved. What is your notice period?');
    expect(s.transcript.map((t) => [t.role, t.text])).toEqual([
      ['user', 'I speak French'],
      ['assistant', 'Saved. What is your notice period?'],
    ]);
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(s.usage.calls).toBe(2);
    expect(streamed.some((e) => e.type === 'delta')).toBe(true);
    expect(llm.requests[0]!.messages[0]!.content).toMatch(/You are the CV coach[\s\S]*# Live state/);
    expect((await store.getProfile()).facts).toContain('Speaks French');
    expect((await store.getSession(session.id)).messages).toHaveLength(4);
  });

  it('keeps the opening note out of the visible transcript', async () => {
    llm.push('coord', say('Hi! Let us start with your current role.'));
    const { session: s } = await runTurn(deps, session.id, { text: OPENING_NOTE, hidden: true }, () => undefined);
    expect(s.transcript).toEqual([expect.objectContaining({ role: 'assistant' })]);
    expect(s.messages[0]!.content).toBe(OPENING_NOTE);
  });

  it('records sub-agent activity in the transcript and persists the active job set by tools', async () => {
    const jobId = (await store.saveJob(JOB)).id;
    llm.push('coord', call('set_active_job', { jobId }), say('Switched.'));
    const { session: s } = await runTurn(deps, session.id, { text: 'work on Babbage' }, () => undefined);
    expect(s.activeJobId).toBe(jobId);
    expect((await store.getSession(session.id)).activeJobId).toBe(jobId);
  });

  it('saves the user message and the error when the model fails', async () => {
    await expect(runTurn(deps, session.id, { text: 'hello' }, () => undefined)).rejects.toThrow(/no scripted reply/);
    const s = await store.getSession(session.id);
    expect(s.transcript.map((t) => t.role)).toEqual(['user', 'event']);
    expect(s.transcript[1]!.text).toMatch(/^Error:/);
    expect((await store.readAudit()).at(-1)).toMatchObject({ actor: 'coordinator', action: 'turn', outcome: 'error' });
  });
});
