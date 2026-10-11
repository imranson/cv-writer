import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agents/events.ts';
import { buildWriterTask, runWriter } from '../../src/agents/writer.ts';
import { critiqueInput, CV_HTML, LISTING, PROFILE } from '../support/fixtures.ts';
import { makeEnv, type TestEnv } from '../support/env.ts';
import { call, say } from '../support/scriptedModel.ts';

let env: TestEnv;
let jobId: string;

beforeEach(async () => {
  env = await makeEnv();
  await env.store.writeProfile(PROFILE);
  jobId = (await env.store.createJob({ title: 'Senior PM', company: 'Brightwave', listing: LISTING })).id;
});
afterEach(() => env.cleanup());

describe('runWriter', () => {
  it('drafts a CV with write_cv, sees automated checks and reports back', async () => {
    env.models.writer.push(call('write_cv', { html: `\`\`\`html\n${CV_HTML}<script>x</script>\n\`\`\`` }), say('- Drafted the CV\nQuestions for the candidate: none'));
    const events: AgentEvent[] = [];
    const result = await runWriter(env.deps, { jobId, instructions: 'Draft a first version', emit: (e) => events.push(e) });

    expect(result.changed).toBe(true);
    expect(result.report).toContain('Drafted the CV');
    expect(result.words).toBeGreaterThan(50);
    const saved = (await env.store.readCv(jobId))!;
    expect(saved).toContain('<h1>Alex Morgan</h1>');
    expect(saved).not.toContain('<script>');
    expect(events).toContainEqual({ type: 'artifact', kind: 'cv', jobId });
    const toolResult = env.models.writer.requests[1]!.messages.at(-1)!.content;
    expect(toolResult).toMatch(/^Saved \(\d+ words\)\.\nAutomated checks/);
  });

  it('includes the task, listing, profile, current CV and latest critique in the brief', async () => {
    await env.store.writeCv(jobId, CV_HTML);
    await env.store.addCritique(jobId, { ...critiqueInput(), score: 70, verdict: 'needs_work', checks: [], createdAt: '', cvHash: '' });
    const task = await buildWriterTask(env.deps, { jobId, instructions: 'Tighten the summary' });
    expect(task).toContain('# Task from the coordinator\nTighten the summary');
    expect(task).toContain('Brightwave is hiring');
    expect(task).toContain('Lumen Health (Jan 2021');
    expect(task).toContain('# Current CV (HTML)');
    expect(task).toContain('Score: 70/100');
  });

  it('edits the CV by exact find/replace and reports edit errors back to the model', async () => {
    await env.store.writeCv(jobId, CV_HTML);
    env.models.writer.push(
      call('edit_cv', { find: 'not in the cv', replace: 'x' }),
      call('edit_cv', { find: 'Product manager with healthcare experience', replace: 'Healthcare product manager' }),
      say('Edited the summary.'),
    );
    const result = await runWriter(env.deps, { jobId, instructions: 'Edit the summary' });
    expect(env.models.writer.requests[1]!.messages.at(-1)!.content).toMatch(/was not found/);
    expect(await env.store.readCv(jobId)).toContain('Healthcare product manager');
    expect(result.changed).toBe(true);
  });

  it('can ask the critic once per run', async () => {
    await env.store.writeCv(jobId, CV_HTML);
    env.models.writer.push(call('request_critique', { focus: 'bullets' }), call('request_critique', {}), say('Polished.'));
    env.models.critic.push(call('submit_critique', critiqueInput()));
    await runWriter(env.deps, { jobId, instructions: 'Polish' });
    expect(env.models.writer.requests[1]!.messages.at(-1)!.content).toMatch(/^Score: 89\/100/);
    expect(env.models.writer.requests[2]!.messages.at(-1)!.content).toMatch(/Critique limit reached/);
    expect(await env.store.readCritiques(jobId)).toHaveLength(1);
  });

  it('exposes read tools and page counting', async () => {
    await env.store.writeCv(jobId, CV_HTML);
    env.pdf.pageCount = 2;
    env.models.writer.push(call('read_cv', { format: 'text' }), call('check_pages'), call('read_job'), call('read_skill', { id: 'professional-summary' }), say('No changes needed.'));
    const result = await runWriter(env.deps, { jobId, instructions: 'Check' });
    const outputs = env.models.writer.requests.slice(1).map((r) => r.messages.at(-1)!.content);
    expect(outputs[0]).toContain('# Alex Morgan');
    expect(outputs[1]).toBe('The CV renders to 2 page(s).');
    expect(outputs[2]).toContain('# Senior PM — Brightwave');
    expect(outputs[3]).toContain('# Professional summary');
    expect(result).toMatchObject({ changed: false, report: 'No changes needed.' });
  });
});
