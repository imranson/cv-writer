import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEdit, checkCv, describeCv, formatFindings, skillTools } from '../../src/agents/commonTools.ts';
import { executeToolCall } from '../../src/agents/loop.ts';
import { CV_HTML, PROFILE } from '../support/fixtures.ts';
import { makeEnv, type TestEnv } from '../support/env.ts';

let env: TestEnv;
beforeEach(async () => (env = await makeEnv()));
afterEach(() => env.cleanup());

describe('applyEdit', () => {
  it('replaces exactly one occurrence, or all when asked', () => {
    expect(applyEdit('a b a', 'b', 'c')).toBe('a c a');
    expect(applyEdit('a b a', 'a', 'z', true)).toBe('z b z');
    expect(applyEdit('cost $1', '$1', '$&2')).toBe('cost $&2');
    expect(() => applyEdit('a b a', 'a', 'z')).toThrow(/occurs 2 times/);
    expect(() => applyEdit('abc', 'x', 'y')).toThrow(/not found/);
    expect(() => applyEdit('abc', '', 'y')).toThrow(/must not be empty/);
  });
});

describe('formatFindings', () => {
  it('lists problems and keeps info notes short', () => {
    expect(formatFindings([{ id: 'w', severity: 'info', message: '120 words.' }])).toBe('Automated checks: no problems found. 120 words.');
    expect(formatFindings([{ id: 'x', severity: 'error', message: 'Bad' }])).toBe('Automated checks:\n- [error] Bad');
  });
});

describe('CV helpers', () => {
  it('describes CVs as text or HTML and runs checks', async () => {
    const job = await env.store.createJob({ title: 'PM', company: 'Co', listing: 'x' });
    expect(await describeCv(env.store, job.id)).toMatch(/No CV has been written/);
    await env.store.writeProfile(PROFILE);
    await env.store.writeCv(job.id, CV_HTML);
    expect(await describeCv(env.store, job.id)).toMatch(/^# Alex Morgan[\s\S]*\(\d+ words\)$/);
    expect(await describeCv(env.store, job.id, 'html')).toContain('<h1>');
    expect((await checkCv(env.store, job.id, 5)).find((f) => f.id === 'page-count')?.severity).toBe('error');
  });
});

describe('skill tools', () => {
  it('lists and reads skills for the agent audience', async () => {
    const tools = skillTools(env.skills, 'critic');
    const ctx = { emit: () => {} };
    const list = await executeToolCall(tools, 'list_skills', {}, ctx);
    expect(list.output).toContain('critique-rubric');
    expect(list.output).not.toContain('evidence-interviewing');
    expect((await executeToolCall(tools, 'read_skill', { id: 'ats-optimisation' }, ctx)).output).toMatch(/^# ATS-friendly formatting/);
    expect((await executeToolCall(tools, 'read_skill', { id: 'nope' }, ctx)).output).toMatch(/No skill with id "nope"/);
  });
});
