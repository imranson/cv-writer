import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromePdfRenderer, countPdfPages, findChrome, type PdfRenderer } from '../../src/cv/pdf.js';
import type { CvDocument } from '../../src/domain/schemas.js';
import type { ChatRequest } from '../../src/llm/types.js';
import { Store } from '../../src/storage/store.js';
import { CRITIQUE, LISTING, tempDir } from '../support/fixtures.js';
import { converse, getJson, send, startServer } from '../support/http.js';
import { call, say, ScriptedModel } from '../support/scripted.js';

/** The writer reads entry ids from its brief, as a real model would. */
function idsFromBrief(req: ChatRequest): { exp: string; edu: string } {
  const brief = req.messages.find((m) => m.role === 'user')!.content;
  const exp = /"id": "(experience-[0-9a-f]+)"/.exec(brief)?.[1];
  const edu = /"id": "(education-[0-9a-f]+)"/.exec(brief)?.[1];
  if (!exp || !edu) throw new Error('profile ids missing from the writer brief');
  return { exp, edu };
}

function cv(ids: { exp: string; edu: string }, bullets: string[]): CvDocument {
  return {
    name: 'Ada Lovelace',
    headline: 'Software Engineer',
    contact: { email: 'ada@example.com', location: 'London, UK', links: [] },
    summary: 'Backend engineer with Python, AWS and Terraform experience, moving into platform engineering.',
    sections: [
      {
        kind: 'entries',
        title: 'Experience',
        items: [{ heading: 'Software Engineer', subheading: 'Analytical Engines Ltd', location: 'London', dates: 'Sep 2021 – Present', sources: [ids.exp], bullets: bullets.map((text) => ({ text, sources: [] })) }],
      },
      { kind: 'entries', title: 'Education', items: [{ heading: 'BSc Mathematics', subheading: 'University of London', dates: '2018 – 2021', sources: [ids.edu], bullets: [] }] },
      { kind: 'skills', title: 'Skills', groups: [{ label: 'Technical', items: ['Python', 'AWS', 'Terraform', 'GitHub Actions'] }] },
    ],
  };
}

const BULLETS = ['Built a Python payments API serving 40,000 requests per minute', 'Cut deployment time from 45 to 8 minutes with GitHub Actions'];
const TERRAFORM = 'Managed 30 AWS accounts with Terraform';

describe('the whole journey, from hello to a submission-ready PDF', () => {
  let cleanup: () => Promise<void>;
  let store: Store;
  let server: { url: string; close: () => Promise<void> };
  let llm: ScriptedModel;
  let realChrome: boolean;
  let sessionId: string;

  beforeAll(async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    store = new Store(t.dir);
    llm = new ScriptedModel({});
    const chrome = await findChrome();
    realChrome = Boolean(chrome);
    const pdf: PdfRenderer = chrome ? chromePdfRenderer(chrome) : async () => Buffer.from('%PDF-1.4 /Type /Page %%EOF');
    server = await startServer({ store, llm, models: { coordinator: 'coord', writer: 'writer', critic: 'critic' }, pdf });
  });
  afterAll(async () => {
    await server?.close();
    await cleanup?.();
  });

  const turn = async (text: string) => {
    const r = await converse(`${server.url}/api/sessions/${sessionId}/messages`, { text });
    if (r.error) throw new Error(r.error);
    return r;
  };

  it('greets a new user and asks for the basics', async () => {
    sessionId = ((await (await send('POST', `${server.url}/api/sessions`)).json()) as { id: string }).id;
    llm.push('coord', (req) => {
      expect(req.messages[0]!.content).toContain('- Full name is missing.');
      return say("Hi! I'm your CV coach. We'll build your profile, then a CV for a specific job. What's your name and email?");
    });
    const r = await converse(`${server.url}/api/sessions/${sessionId}/open`);
    expect(r.reply).toMatch(/your name and email/);
  });

  it('interviews the user and saves the profile as it goes', async () => {
    llm.push('coord', call('update_contact', { name: 'Ada Lovelace', email: 'ada@example.com', location: 'London, UK' }), say('Thanks Ada. What is your current role?'));
    await turn("I'm Ada Lovelace, ada@example.com, based in London, UK");

    llm.push(
      'coord',
      call('add_profile_entry', { section: 'experience', title: 'Software Engineer', organisation: 'Analytical Engines Ltd', location: 'London', startDate: 'Sep 2021', endDate: 'Present', highlights: BULLETS, skills: ['Python', 'AWS', 'GitHub Actions'] }),
      call('set_career_goal', { headline: 'Platform engineering roles' }),
      say('Great numbers. And your education?'),
    );
    await turn('Software Engineer at Analytical Engines since Sep 2021. Built a Python payments API at 40,000 requests a minute and cut deploys from 45 to 8 minutes with GitHub Actions. I want platform roles.');

    llm.push('coord', call('add_profile_entry', { section: 'education', title: 'BSc Mathematics', organisation: 'University of London', startDate: '2018', endDate: '2021' }), say('Got it. Do you have a job listing in mind? Paste it or send a link.'));
    const r = await turn('BSc Maths, University of London, 2018 to 2021.');
    expect(r.events.some((e) => e.event === 'state')).toBe(true);

    const { profile } = await getJson<{ profile: { revision: number; entries: unknown[] } }>(`${server.url}/api/profile`);
    expect(profile.revision).toBe(4);
    expect(profile.entries).toHaveLength(2);
  });

  it('saves the pasted job listing verbatim and asks about gaps before writing', async () => {
    llm.push(
      'coord',
      call('save_job_listing', { title: 'Platform Engineer', company: 'Babbage Systems', location: 'London', requirements: ['Python or Go', 'AWS', 'Terraform', 'CI/CD'], keywords: ['Python', 'AWS', 'Terraform', 'GitHub Actions'] }),
      (req) => {
        expect(req.messages[0]!.content).toContain('## Active job: Platform Engineer at Babbage Systems');
        return say('Saved. The listing wants Terraform — have you used it?');
      },
    );
    await turn(LISTING);
    const [job] = await getJson<Array<{ id: string; description: string }>>(`${server.url}/api/jobs`);
    expect(job!.description).toBe(LISTING);
  });

  it('adds the new evidence, then has the writer draft and the critic review', async () => {
    llm.push('coord', (req) => {
      const exp = /"id":"(experience-[0-9a-f]+)"/.exec(req.messages[0]!.content)![1]!;
      return call('update_profile_entry', { id: exp, addHighlights: [TERRAFORM], addSkills: ['Terraform'] });
    });
    llm.push('coord', call('write_cv', { instructions: 'Tailor to platform engineering; lead with infrastructure work.' }));
    llm.push(
      'writer',
      // First draft invents a number; the automatic checks catch it.
      (req) => call('save_cv', { document: cv(idsFromBrief(req), [...BULLETS, 'Reduced cloud costs by 25%']), changeSummary: 'First draft' }),
      (req) => call('save_cv', { document: cv(idsFromBrief(req), [TERRAFORM, ...BULLETS]), changeSummary: 'Removed unsupported claim' }),
      call('request_critique', { version: 2 }),
      say('v2 is final. Question: have you used Kubernetes?'),
    );
    llm.push('critic', (req) => {
      expect(req.messages[1]!.content).toContain(TERRAFORM);
      return call('submit_review', { ...CRITIQUE, overallScore: 82, issues: [{ severity: 'minor', category: 'wording', problem: 'Summary is generic' }] });
    }, say('done'));
    llm.push('coord', (req) => {
      const result = JSON.parse(req.messages.at(-1)!.content);
      expect(result).toMatchObject({ versionsSaved: [1, 2], latestVersion: 2 });
      return say('v2 is ready in the CV panel — the critic gave it 82/100. Anything you want changed?');
    });
    const r = await turn('Yes — I managed 30 AWS accounts with Terraform at Analytical Engines.');
    const activity = r.events.filter((e) => e.event === 'activity').map((e) => (e.data as { text: string }).text);
    expect(activity).toEqual(expect.arrayContaining(['Writer is drafting a new CV…', 'Critic is reviewing v2…', 'Critic scored v2 82/100 (needs work)']));
    expect(r.reply).toMatch(/82\/100/);

    const [job] = await getJson<Array<{ id: string }>>(`${server.url}/api/jobs`);
    const versions = await getJson<Array<{ version: number; errors: number; score?: number }>>(`${server.url}/api/jobs/${job!.id}/cvs`);
    expect(versions.map((v) => [v.version, v.errors > 0, v.score])).toEqual([
      [1, true, undefined],
      [2, false, 82],
    ]);
  });

  it('revises from the user’s feedback, verbatim', async () => {
    const feedback = 'Can you make the summary less generic and mention I want to build developer platforms?';
    llm.push('coord', call('write_cv', { instructions: 'Rewrite the summary.', base_version: 2, user_feedback: feedback }));
    llm.push(
      'writer',
      (req) => {
        expect(req.messages[1]!.content).toContain(feedback);
        const doc = cv(idsFromBrief(req), [TERRAFORM, ...BULLETS]);
        doc.summary = 'Software engineer who builds infrastructure with Terraform and AWS, aiming at platform engineering.';
        return call('save_cv', { document: doc, changeSummary: 'Specific summary' });
      },
      call('request_critique', { version: 3 }),
      say('v3 final.'),
    );
    llm.push('critic', call('submit_review', { ...CRITIQUE, overallScore: 88, verdict: 'ready', issues: [] }), say('done'));
    llm.push('coord', say('v3 scores 88/100 and the critic says it is ready. Want to adjust the look before I finalise it?'));
    await turn(feedback);
  });

  it('changes the style on request and approves the final version as a PDF', async () => {
    llm.push('coord', call('update_style', { fontFamily: 'garamond', marginVerticalMm: 12, marginHorizontalMm: 14, sectionSpacingPt: 8 }), say('Switched to EB Garamond with tighter margins.'));
    await turn('Use Garamond and tighter margins please.');
    expect(await getJson(`${server.url}/api/style`)).toMatchObject({ fontFamily: 'garamond', marginVerticalMm: 12 });

    llm.push('coord', call('approve_cv', { version: 3 }), (req) => {
      const result = JSON.parse(req.messages.at(-1)!.content);
      expect(result.approved).toBe('v3');
      return say(`Done — your CV is at ${result.files.pdf ?? result.files.html}.`);
    });
    const r = await turn('Looks great, approve it.');
    expect(r.reply).toMatch(/Done — your CV is at/);
  });

  it('leaves a complete, traceable record', async () => {
    const [job] = await getJson<Array<{ id: string }>>(`${server.url}/api/jobs`);
    const v3 = await store.getCvVersion(job!.id, 3);
    expect(v3).toMatchObject({ status: 'approved', basedOnVersion: 2, feedback: 'Can you make the summary less generic and mention I want to build developer platforms?', profileRevision: 5 });
    expect(v3.critiques[0]).toMatchObject({ requestedBy: 'writer', verdict: 'ready' });
    const exported = v3.exports.at(-1)!;
    expect(exported.style.fontFamily).toBe('garamond');
    expect(await readFile(exported.html, 'utf8')).toContain('EB Garamond');
    const pdf = await readFile(exported.pdf!);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    if (realChrome) {
      expect(countPdfPages(pdf)).toBe(1);
      expect(exported.pages).toBe(1);
    }

    // The profile revision the CV was written from is in the history, with the Terraform fact.
    const history = await store.profileHistory();
    expect(history.find((h) => h.revision === v3.profileRevision)!.snapshot.entries[0]!.highlights).toContain(TERRAFORM);

    // Every agent's work is on file.
    const writerRun = await store.getRun(v3.writerRunId);
    expect(writerRun).toMatchObject({ agent: 'writer', outcome: 'completed' });
    expect((await store.getRun(v3.critiques[0]!.runId)).agent).toBe('critic');
    const audit = await store.readAudit(500);
    const actors = new Set(audit.map((a) => a.actor));
    expect([...actors]).toEqual(expect.arrayContaining(['coordinator', 'writer', 'critic']));
    expect(audit.some((a) => a.actor === 'coordinator' && a.action === 'approve_cv' && a.outcome === 'ok')).toBe(true);

    const session = await store.getSession(sessionId);
    expect(session.transcript.filter((t) => t.role === 'user')).toHaveLength(8);
    expect(session.transcript.some((t) => t.role === 'event' && /Critic scored v3 88\/100/.test(t.text))).toBe(true);
    for (const model of ['coord', 'writer', 'critic']) expect(llm.remaining(model)).toBe(0);
  });
});
