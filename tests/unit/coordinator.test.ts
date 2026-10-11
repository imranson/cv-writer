import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCoordinatorSystemPrompt, coordinatorTools, describeState, type CoordinatorState } from '../../src/agents/coordinator.ts';
import type { AgentEvent } from '../../src/agents/events.ts';
import { executeToolCall } from '../../src/agents/loop.ts';
import type { AgentTool } from '../../src/agents/tool.ts';
import { STYLE_PRESETS } from '../../src/cv/styles.ts';
import { critiqueInput, CV_HTML, LISTING, PROFILE } from '../support/fixtures.ts';
import { makeEnv, type TestEnv } from '../support/env.ts';
import { call, say } from '../support/scriptedModel.ts';

let env: TestEnv;
let state: CoordinatorState;
let events: AgentEvent[];
let tools: AgentTool[];

const run = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await executeToolCall(tools, name, args, { emit: (e) => events.push(e) });
  return r.output;
};

beforeEach(async () => {
  env = await makeEnv({ fetchPage: async (url) => ({ url, title: 'Job page', text: url.includes('short') ? 'Sign in' : 'Senior PM role. '.repeat(30) }) });
  state = { jobId: null };
  events = [];
  tools = coordinatorTools(env.deps, state, { emit: (e) => events.push(e) });
});
afterEach(() => env.cleanup());

describe('coordinator tools', () => {
  it('exposes the expected toolset', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'critique_cv', 'edit_profile', 'export_pdf', 'fetch_url', 'list_jobs', 'list_skills', 'read_cv', 'read_job', 'read_profile',
        'read_skill', 'read_style', 'save_job', 'set_active_job', 'set_style', 'update_job', 'update_profile', 'write_cv',
      ].sort(),
    );
  });

  it('writes and edits the profile, guarding against accidental data loss', async () => {
    expect(await run('read_profile')).toBe('(The profile is empty.)');
    expect(await run('update_profile', { markdown: PROFILE })).toMatch(/Profile saved/);
    expect(events).toContainEqual({ type: 'artifact', kind: 'profile' });
    expect(await run('update_profile', { markdown: '# Alex' })).toMatch(/much shorter/);
    expect(await env.store.readProfile()).toBe(PROFILE);
    expect(await run('update_profile', { markdown: '# Alex', allow_shrink: true })).toMatch(/saved/);

    await env.store.writeProfile(PROFILE);
    expect(await run('edit_profile', { find: '- UK spelling', replace: '- UK spelling\n- Formal tone' })).toBe('Profile updated.');
    expect(await env.store.readProfile()).toContain('- Formal tone');
    expect(await run('edit_profile', { find: '- Maximum', replace: 'x', replace_all: false })).toBe('Profile updated.');
    expect(await run('edit_profile', { find: 'nowhere', replace: 'x' })).toMatch(/not found/);
  });

  it('saves jobs, makes them active and resolves the active job by default', async () => {
    expect(await run('read_job')).toMatch(/No active job/);
    const out = await run('save_job', { title: 'Senior PM', company: 'Brightwave', listing: LISTING });
    expect(out).toMatch(/It is now the active job/);
    expect(state.jobId).toMatch(/^brightwave-senior-pm-/);
    expect(events).toContainEqual({ type: 'artifact', kind: 'session', jobId: state.jobId });
    expect(await run('read_job')).toContain('Brightwave is hiring');
    expect(await run('update_job', { title: 'Lead PM' })).toMatch(/updated/);
    expect((await env.store.getJob(state.jobId!))?.title).toBe('Lead PM');
    expect(await run('list_jobs')).toContain('[active]');
    expect(await run('set_active_job', { job_id: 'missing' })).toMatch(/not found/);
  });

  it('delegates drafting to the writer and assessment to the critic', async () => {
    await env.store.writeProfile(PROFILE);
    await run('save_job', { title: 'Senior PM', company: 'Brightwave', listing: LISTING });
    env.models.writer.push(call('write_cv', { html: CV_HTML }), say('Drafted.'));
    const written = await run('write_cv', { instructions: 'Draft it' });
    expect(written).toMatch(/^CV saved \(\d+ words\)\.\nWriter report:\nDrafted\./);
    expect(env.models.writer.requests[0]!.messages[1]!.content).toContain('Draft it');

    env.models.critic.push(call('submit_critique', critiqueInput()));
    expect(await run('critique_cv', { focus: 'accuracy' })).toMatch(/^Score: 89\/100 — verdict: ready/);
    expect(await run('read_cv')).toContain('- Led discovery and launch');
    expect(await run('read_cv', { format: 'html' })).toContain('<h1>Alex Morgan</h1>');
  });

  it('applies style presets or raw CSS', async () => {
    await run('save_job', { title: 'PM', company: 'Co', listing: 'x' });
    expect(await run('read_style')).toContain('Presets:');
    expect(await run('set_style', {})).toMatch(/Provide a preset or css/);
    expect(await run('set_style', { preset: 'nope' })).toMatch(/Unknown preset/);
    expect(await run('set_style', { preset: 'modern' })).toBe('Style updated.');
    expect(await env.store.readStyle(state.jobId!)).toBe(STYLE_PRESETS[1]!.css);
    await run('set_style', { css: 'body { color: red; }' });
    expect(await env.store.readStyle(state.jobId!)).toBe('body { color: red; }');
    expect(events).toContainEqual({ type: 'artifact', kind: 'style', jobId: state.jobId });
  });

  it('reports readiness and a download link on export', async () => {
    await env.store.writeProfile(PROFILE);
    await run('save_job', { title: 'PM', company: 'Co', listing: 'x' });
    expect(await run('export_pdf')).toMatch(/no CV/);
    await env.store.writeCv(state.jobId!, CV_HTML);
    env.pdf.pageCount = 1;
    const report = await run('export_pdf');
    expect(report).toContain('PDF rendered: 1 page(s).');
    expect(report).toContain('No critique yet');
    expect(report).toContain(`/api/jobs/${state.jobId}/pdf?download=1`);
    expect(env.pdf.rendered[0]).toContain('<style>');
    env.pdf.pageCount = 4;
    expect(await run('export_pdf')).toContain('NOT READY');
  });

  it('fetches job listing URLs and flags pages that need a login', async () => {
    expect(await run('fetch_url', { url: 'https://jobs.example.com/1' })).toMatch(/^Title: Job page/);
    expect(await run('fetch_url', { url: 'https://jobs.example.com/short' })).toMatch(/Ask the user to paste/);
  });
});

describe('coordinator prompt', () => {
  it('describes an empty workspace', async () => {
    const text = await describeState(env.deps, { jobId: null, summary: '' });
    expect(text).toContain('Today: 2026-10-10');
    expect(text).toContain('Profile: EMPTY');
    expect(text).toContain('Saved jobs: none.');
    expect(text).toContain('ACTIVE JOB: none');
  });

  it('describes profile, jobs, the active CV, critique staleness and compacted history', async () => {
    await env.store.writeProfile('# Alex\n\n## Experience\n- x');
    const job = await env.store.createJob({ title: 'PM', company: 'Co', listing: 'x' });
    await env.store.writeCv(job.id, CV_HTML);
    await env.store.addCritique(job.id, { ...critiqueInput(), score: 72, verdict: 'needs_work', checks: [], createdAt: '', cvHash: 'old' });
    const text = await describeState(env.deps, { jobId: job.id, summary: 'User wants a bold tone.' });
    expect(text).toContain('Headings: Alex | Experience');
    expect(text).toContain('no "Preferences" section');
    expect(text).toContain(`ACTIVE JOB: ${job.id} — PM at Co`);
    expect(text).toContain('Latest critique: 72/100, verdict needs_work (the CV has changed since');
    expect(text).toContain('User wants a bold tone.');
  });

  it('includes the role, autoloaded coach skills and the skill index', async () => {
    const prompt = await buildCoordinatorSystemPrompt(env.deps, { jobId: null, summary: '' });
    expect(prompt).toContain('You are the CV coach and coordinator');
    expect(prompt).toContain('# Skill: Interviewing for evidence');
    expect(prompt).toContain('tailoring-to-job');
    expect(prompt).toContain('# Current state');
  });
});
