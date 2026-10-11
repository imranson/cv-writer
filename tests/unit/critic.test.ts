import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCriticSystemPrompt, CriticError, parseCritiqueFromText, runCritic } from '../../src/agents/critic.ts';
import type { AgentEvent } from '../../src/agents/events.ts';
import { hashText } from '../../src/util/text.ts';
import { critiqueInput, CV_HTML, LISTING, PROFILE } from '../support/fixtures.ts';
import { makeEnv, type TestEnv } from '../support/env.ts';
import { call, say } from '../support/scriptedModel.ts';

let env: TestEnv;
let jobId: string;

beforeEach(async () => {
  env = await makeEnv();
  await env.store.writeProfile(PROFILE);
  jobId = (await env.store.createJob({ title: 'Senior PM', company: 'Brightwave', listing: LISTING })).id;
  await env.store.writeCv(jobId, CV_HTML);
});
afterEach(() => env.cleanup());

describe('runCritic', () => {
  it('gives the critic the listing, profile, CV and automated checks, then stores a scored critique', async () => {
    env.models.critic.push(call('submit_critique', critiqueInput()));
    env.pdf.pageCount = 1;
    const events: AgentEvent[] = [];
    const critique = await runCritic(env.deps, { jobId, focus: 'the summary', emit: (e) => events.push(e) });

    const task = env.models.critic.requests[0]!.messages[1]!.content;
    expect(task).toContain('Senior PM');
    expect(task).toContain('Brightwave is hiring');
    expect(task).toContain('Alex Morgan');
    expect(task).toContain('<h1>Alex Morgan</h1>');
    expect(task).toContain('Pay particular attention to: the summary');
    expect(task).toContain('Automated checks');
    expect(task).toContain('1 page(s)');

    expect(critique.score).toBe(89);
    expect(critique.verdict).toBe('ready');
    expect(critique.cvHash).toBe(hashText((await env.store.readCv(jobId))!));
    expect(critique.createdAt).toBe('2026-10-10T12:00:00.000Z');
    expect(critique.checks.find((c) => c.id === 'page-count')?.severity).toBe('info');
    expect(await env.store.latestCritique(jobId)).toEqual(critique);
    expect(events).toContainEqual({ type: 'artifact', kind: 'critique', jobId });
  });

  it('lets the critic fix an invalid submission', async () => {
    env.models.critic.push(call('submit_critique', { summary: 'x' }), call('submit_critique', critiqueInput()));
    const critique = await runCritic(env.deps, { jobId });
    expect(critique.summary).toBe(critiqueInput().summary);
    const feedback = env.models.critic.requests[1]!.messages.at(-1)!;
    expect(feedback).toMatchObject({ role: 'tool', toolName: 'submit_critique' });
    expect(feedback.content).toMatch(/invalid arguments.*scores/);
  });

  it('accepts a critique sent as JSON text instead of a tool call', async () => {
    env.models.critic.push(say(`Here you go:\n${JSON.stringify(critiqueInput())}`));
    expect((await runCritic(env.deps, { jobId })).score).toBe(89);
  });

  it('downgrades the verdict when blocking automated checks fail', async () => {
    env.pdf.pageCount = 3;
    env.models.critic.push(call('submit_critique', critiqueInput()));
    const c = await runCritic(env.deps, { jobId });
    expect(c.checks.find((x) => x.id === 'page-count')?.severity).toBe('error');
    expect(c.verdict).toBe('needs_work');
  });

  it('fails clearly when there is no CV or no valid critique', async () => {
    const empty = (await env.store.createJob({ title: 'X', company: 'Y', listing: '' })).id;
    await expect(runCritic(env.deps, { jobId: empty })).rejects.toBeInstanceOf(CriticError);
    env.models.critic.push(say('I think it is fine.'));
    await expect(runCritic(env.deps, { jobId })).rejects.toThrow(/did not return a valid critique/);
  });

  it('builds a system prompt with the autoloaded rubric and a skill index', async () => {
    const prompt = await buildCriticSystemPrompt(env.deps);
    expect(prompt).toContain('# Skill: CV critique rubric');
    expect(prompt).toContain('read_skill');
    expect(prompt).toContain('common-cv-mistakes');
  });
});

describe('parseCritiqueFromText', () => {
  it('extracts embedded JSON or returns null', () => {
    expect(parseCritiqueFromText(`xx ${JSON.stringify(critiqueInput())} yy`)?.summary).toBeTruthy();
    expect(parseCritiqueFromText('{"summary": 1}')).toBeNull();
    expect(parseCritiqueFromText('no json')).toBeNull();
  });
});
