import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationService } from '../../src/agents/conversation.ts';
import { countPdfPages, PdfRenderer } from '../../src/cv/pdf.ts';
import { STYLE_PRESETS } from '../../src/cv/styles.ts';
import type { ChatRequest } from '../../src/llm/types.ts';
import { createApp } from '../../src/server/app.ts';
import { critiqueInput, CV_HTML, LISTING, PROFILE } from '../support/fixtures.ts';
import { makeEnv, type TestEnv } from '../support/env.ts';
import { client } from '../support/http.ts';
import { call, say } from '../support/scriptedModel.ts';

/**
 * The whole product journey with scripted models: interview → profile → job listing →
 * gap question → draft → critique → fix → re-critique → style → export a ready PDF.
 */
let env: TestEnv;
let api: ReturnType<typeof client>;
const pdf = new PdfRenderer();
const systemOf = (req: ChatRequest) => req.messages[0]!.content;

/** Sends a message and fails if the turn did not finish cleanly (assertions inside scripted steps surface as error events). */
async function chat(sessionId: string, text: string) {
  const result = await api.chat(sessionId, text);
  expect(result.events.find((e) => e.type === 'error')?.message).toBeUndefined();
  expect(result.events.at(-1)?.type).toBe('done');
  return result;
}

beforeAll(async () => {
  env = await makeEnv();
  env.deps.pdf = pdf;
  api = client(createApp({ deps: env.deps, conversation: new ConversationService(env.deps, { compactThreshold: 0.8 }) }));
});
afterAll(async () => {
  await pdf.close();
  await env.cleanup();
});

describe('CV journey', () => {
  let sessionId: string;
  let jobId: string;

  it('1. greets the user and starts the profile interview', async () => {
    sessionId = (await api.post('/api/sessions', {})).data.id;
    env.models.coordinator.push((req) => {
      expect(systemOf(req)).toContain('Profile: EMPTY');
      return say("Let's build your profile. What's your name, and your current or most recent role?");
    });
    await chat(sessionId, 'Hi! I need a CV.');
  });

  it('2. saves the background the user shares and asks for the job', async () => {
    env.models.coordinator.push(call('update_profile', { markdown: PROFILE }), say('Got it, Alex. Which job are you applying for? Paste the listing or a link.'));
    await chat(sessionId, 'Alex Morgan, PM at Lumen Health since 2021 … (full background)');
    expect((await api.get('/api/profile')).data.markdown).toContain('Lumen Health');
  });

  it('3. saves the job listing and asks about a gap before drafting', async () => {
    env.models.coordinator.push(
      call('save_job', { title: 'Senior Product Manager', company: 'Brightwave', listing: LISTING }),
      (req) => {
        expect(req.messages.at(-1)!.content).toMatch(/It is now the active job/);
        return say('Saved. The role asks for experimentation — have you run A/B tests? Rough numbers are fine.');
      },
    );
    const { events } = await chat(sessionId, LISTING);
    const session = (await api.get(`/api/sessions/${sessionId}`)).data;
    jobId = session.jobId;
    expect(jobId).toMatch(/^brightwave-senior-product-manager-/);
    expect(events.some((e) => e.type === 'session' && e.session.jobId === jobId)).toBe(true);
  });

  it('4. records the new evidence, drafts the CV and gets it critiqued', async () => {
    env.models.coordinator.push(
      call('edit_profile', { find: '- Cut appointment no-shows by 18% with SMS reminders.', replace: '- Cut appointment no-shows by 18% with SMS reminders, validated with an A/B test.' }),
      call('write_cv', { instructions: 'Draft a CV targeting the Senior PM role; lead with healthcare and experimentation.' }),
      call('critique_cv', {}),
      (req) => {
        expect(req.messages.at(-1)!.content).toMatch(/^Score: \d+\/100 — verdict: needs work/);
        return say('First draft is up (score 74). The critic wants the A/B test made explicit in your Lumen bullets. Shall I fix that?');
      },
    );
    env.models.writer.push(
      (req) => {
        expect(req.messages[1]!.content).toContain('validated with an A/B test'); // the writer sees the updated profile
        return call('write_cv', { html: CV_HTML });
      },
      say('- Drafted a tailored CV\nQuestions for the candidate: none'),
    );
    env.models.critic.push(
      call('submit_critique', critiqueInput({ scores: { relevance: 7, impact: 7, clarity: 8, structure: 8, accuracy: 8 }, mistakes: [{ severity: 'major', kind: 'content', location: 'Lumen Health', issue: 'A/B testing not evidenced', fix: 'Mention the A/B test' }] })),
    );
    const { events } = await chat(sessionId, 'Yes — the SMS reminder change was validated with an A/B test.');
    expect((await api.get('/api/profile')).data.markdown).toContain('validated with an A/B test');
    expect((await api.get(`/api/jobs/${jobId}/cv`)).data.html).toContain('<h1>Alex Morgan</h1>');
    expect((await api.get('/api/jobs')).data[0]).toMatchObject({ verdict: 'needs_work', hasCv: true });

    // Sub-agent activity is streamed to the UI alongside the coordinator's own events.
    const agents = new Set(events.filter((e) => e.type === 'tool_start').map((e) => e.agent));
    expect([...agents].sort()).toEqual(['coordinator', 'critic', 'writer']);
    expect(events.filter((e) => e.type === 'artifact').map((e) => e.kind)).toEqual(expect.arrayContaining(['profile', 'cv', 'critique']));
  });

  it('5. applies the fix, re-critiques, styles and exports a ready PDF', async () => {
    env.models.coordinator.push(
      call('write_cv', { instructions: 'Make the A/B test explicit in the Lumen Health no-show bullet.' }),
      call('critique_cv', {}),
      call('set_style', { preset: 'modern' }),
      call('export_pdf', {}),
      (req) => {
        const report = req.messages.at(-1)!.content;
        expect(report).toContain('PDF rendered: 1 page(s).');
        expect(report).toContain('Latest critique: 89/100 (ready).');
        expect(report).toContain('No blocking problems');
        return say(`Your CV is ready to submit. [Download the PDF](/api/jobs/${jobId}/pdf?download=1)`);
      },
    );
    env.models.writer.push(
      call('edit_cv', { find: 'by introducing SMS reminders.', replace: 'by introducing SMS reminders, validated with an A/B test.' }),
      say('- Made the A/B test explicit'),
    );
    env.models.critic.push(call('submit_critique', critiqueInput()));
    await chat(sessionId, 'Yes please, then make it look modern and give me the PDF.');

    expect((await api.get(`/api/jobs/${jobId}/cv`)).data.html).toContain('validated with an A/B test');
    expect((await api.get(`/api/jobs/${jobId}/style`)).data.css).toBe(STYLE_PRESETS[1]!.css);
    expect((await api.get(`/api/jobs/${jobId}/critiques`)).data.map((c: { verdict: string }) => c.verdict)).toEqual(['needs_work', 'ready']);
    expect((await api.get(`/api/jobs/${jobId}/cv/versions`)).data).toHaveLength(2);

    const download = await api.get(`/api/jobs/${jobId}/pdf?download=1`);
    expect(download.headers.get('content-disposition')).toContain('Alex Morgan - Brightwave - CV.pdf');
    expect(countPdfPages(download.data)).toBe(1);

    const session = (await api.get(`/api/sessions/${sessionId}`)).data;
    expect(session.messages.at(-1).content).toContain(`/api/jobs/${jobId}/pdf?download=1`);
    expect(session.messages.filter((m: { role: string }) => m.role === 'user')).toHaveLength(5);
    expect(session.context.tokens).toBeGreaterThan(0);
    expect(env.models.coordinator.remaining + env.models.writer.remaining + env.models.critic.remaining).toBe(0);
  });
});
