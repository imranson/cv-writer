import { access, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { startSession } from '../../src/app/session.js';
import { chromePdfRenderer, findChrome, type PdfRenderer } from '../../src/cv/export.js';
import type { CvDocument, Profile } from '../../src/domain/schemas.js';
import type { ChatRequest } from '../../src/llm/types.js';
import { sampleJob, sampleProfile, tempStore } from '../helpers.js';
import { byModel, call, calls, say, ScriptedIO, ScriptedModel } from '../support/scripted.js';

const chrome = await findChrome();
const stubPdf: PdfRenderer = async (_html, out) => writeFile(out, '%PDF-stub');

/** Parsed results of every call to one tool so far in the conversation. */
const resultsOf = (req: ChatRequest, tool: string) =>
  req.messages.filter((m) => m.role === 'tool' && m.tool_name === tool).map((m) => JSON.parse(m.content));

/** The profile the writer was briefed with. */
function briefedProfile(req: ChatRequest): Omit<Profile, 'revision' | 'updatedAt'> {
  const brief = req.messages.find((m) => m.role === 'user')!.content;
  return JSON.parse(brief.match(/# Candidate profile \(revision \d+\)\n```json\n([\s\S]*?)\n```/)![1]!);
}

/** What a capable writer model would produce from the briefed profile. */
function cvFrom(profile: Omit<Profile, 'revision' | 'updatedAt'>, opts: { placeholder?: boolean; shortProfile?: boolean } = {}): CvDocument {
  const entry = (section: string) => profile.entries.find((e) => e.section === section)!;
  const exp = entry('experience');
  const edu = entry('education');
  const contactLine = [profile.contact.location!, profile.contact.email!, profile.contact.phone!];
  if (opts.placeholder) contactLine.push('[LinkedIn URL]');
  return {
    name: profile.contact.name!,
    contactLine,
    sections: [
      {
        title: 'Profile',
        paragraph: opts.shortProfile
          ? 'Computer Science graduate building machine learning services in Python on AWS.'
          : 'Computer Science graduate building machine learning services in Python on AWS. Experienced with privacy-sensitive health data.',
        items: [],
        entries: [],
      },
      {
        title: 'Experience',
        items: [],
        entries: [{ heading: exp.title, subheading: exp.organisation!, dates: `${exp.startDate} – ${exp.endDate}`, bullets: exp.highlights, sourceIds: [exp.id] }],
      },
      {
        title: 'Education',
        items: [],
        entries: [{ heading: edu.title, subheading: edu.organisation!, dates: `${edu.startDate} – ${edu.endDate}`, bullets: [], sourceIds: [edu.id] }],
      },
      { title: 'Skills', items: profile.skills.map((g) => `**${g.category}:** ${g.items.join(', ')}`), entries: [] },
    ],
  };
}

const p = sampleProfile();
const entryArgs = p.entries.map(({ id: _id, ...rest }) => rest);
const LISTING = `${sampleJob().title} — ${sampleJob().company}\n\n${sampleJob().description}`;

/**
 * The whole product, end to end, with scripted models in place of Ollama: the user talks only
 * to the coordinator, which builds the profile, saves the job, delegates drafting to the
 * cv-writer agent, relays feedback and exports the approved CV. Storage, verification,
 * rendering, export, session persistence and auditing are all real.
 */
describe('a CV, from first hello to submission files', () => {
  it.each([
    ['with a stub PDF renderer', false],
    ['with headless Chrome', true],
  ] as const)('%s', async (_label, realChrome) => {
    if (realChrome && !chrome) return; // no browser on this machine
    const store = await tempStore();
    const jobId = (req: ChatRequest) => resultsOf(req, 'save_job_listing')[0].jobId as string;

    const coordinator = new ScriptedModel([
      // Turn 1: kickoff
      call('get_profile'),
      say("Hi! Your profile is empty, so let's build it. What's your name and how can employers reach you?"),
      // Turn 2: contact + goal
      calls(['update_contact', p.contact], ['set_headline', { headline: p.headline }]),
      say('Saved. Tell me about your education and experience.'),
      // Turn 3: entries
      calls(...entryArgs.map((e) => ['upsert_profile_entry', e] as [string, Record<string, unknown>])),
      say('Got all three. What skills should I note?'),
      // Turn 4: skills and facts
      calls(...p.skills.map((g) => ['add_skills', g] as [string, Record<string, unknown>]), ['add_facts', { facts: p.facts }]),
      say('Noted. Which job are you applying for?'),
      // Turn 5: the listing
      call('save_job_listing', { ...sampleJob(), description: LISTING }),
      say('Saved the Acme Health listing. Shall I draft your CV?'),
      // Turn 6: first draft
      (req) => call('write_cv', { jobId: jobId(req) }),
      (req) => {
        const [report] = resultsOf(req, 'write_cv');
        expect(report).toMatchObject({ version: 2, shownToUser: true, intermediateVersions: [1], verification: { passed: true } });
        return say('That is version 2: all checks pass, though Kubernetes is missing. What would you change?');
      },
      // Turn 7: feedback → revision
      (req) =>
        call('write_cv', {
          jobId: jobId(req),
          basedOnVersion: 2,
          feedback: 'Make the profile a single sentence.',
        }),
      say('Version 3 has a one-sentence profile. Happy with it?'),
      // Turn 8: approval
      (req) => call('approve_cv', { jobId: jobId(req), version: 3 }),
      (req) => say(`Done! Your files: ${resultsOf(req, 'approve_cv')[0].files.pdf}`),
    ]);

    const writer = new ScriptedModel([
      // Run 1: a draft with a placeholder, then a fixed one.
      (req) => call('save_cv_version', { document: cvFrom(briefedProfile(req), { placeholder: true }), changeSummary: 'First draft' }),
      (req) => {
        const report = resultsOf(req, 'save_cv_version')[0];
        expect(report.issues.map((i: { code: string }) => i.code)).toEqual(['placeholder']);
        return call('save_cv_version', { document: cvFrom(briefedProfile(req)), changeSummary: 'Removed the placeholder' });
      },
      say('Saved version 2. Led with the internship.'),
      // Run 2: the revision.
      (req) => {
        expect(req.messages[1]!.content).toContain('Revise CV version 2');
        expect(req.messages[1]!.content).toContain('Make the profile a single sentence.');
        return call('save_cv_version', { document: cvFrom(briefedProfile(req), { shortProfile: true }), changeSummary: 'One-sentence profile' });
      },
      say('Saved version 3.'),
    ]);

    const io = new ScriptedIO([
      `I'm ${p.contact.name}, ${p.contact.email}, ${p.contact.phone}, based in ${p.contact.location}. I want backend/ML roles.`,
      'BSc CS at Manchester, a research internship, and a hackathon project.',
      'Python, TypeScript, SQL, AWS. UK spelling please.',
      LISTING,
      'Yes please',
      'Make the profile a single sentence.',
      'Perfect, I approve it.',
      '/quit',
    ]);

    const summary = await startSession({
      store,
      io,
      client: byModel({ 'coordinator-model': coordinator, 'writer-model': writer }),
      model: 'coordinator-model',
      writerModel: 'writer-model',
      pdf: realChrome ? chromePdfRenderer(chrome!) : stubPdf,
      today: 'Sun Oct 04 2026',
    });

    // The whole script was used; the user only ever heard from the coordinator.
    expect(coordinator.remaining).toBe(0);
    expect(writer.remaining).toBe(0);
    expect(summary).toMatchObject({ turns: 8, endedBy: 'user', usage: { requests: 21 } });
    expect(io.said.at(-1)).toMatch(/^Done! Your files: .*alex-morgan-cv-v3\.pdf$/);

    // Profile: complete, with every change in its history.
    const profile = await store.getProfile();
    expect(profile).toMatchObject({ contact: p.contact, headline: p.headline, skills: p.skills, facts: p.facts });
    expect(profile.entries.map((e) => e.title)).toEqual(p.entries.map((e) => e.title));
    expect((await store.profileHistory()).length).toBe(profile.revision);

    // The job, verbatim.
    const [job] = await store.listJobs();
    expect(job!.description).toBe(LISTING);

    // Every CV iteration is kept, chained, and traceable to the writer run that made it.
    const versions = await store.listCvVersions(job!.id);
    expect(versions.map((v) => [v.version, v.status, v.verification.passed, v.basedOnVersion])).toEqual([
      [1, 'draft', false, undefined],
      [2, 'draft', true, 1],
      [3, 'approved', true, 2],
    ]);
    expect(versions[2]!.feedback).toBe('Make the profile a single sentence.');
    const runs = await store.listWriterRuns(job!.id);
    expect(runs.map((r) => [r.savedVersions, r.outcome, r.sessionId])).toEqual([
      [[1, 2], 'saved', summary.sessionId],
      [[3], 'saved', summary.sessionId],
    ]);
    expect(versions.map((v) => v.writerRunId)).toEqual([runs[0]!.id, runs[0]!.id, runs[1]!.id]);

    // The user saw exactly the stored drafts the coordinator reported on, not a retyped copy.
    expect(io.shown.map((v) => v.version)).toEqual([2, 3]);
    expect(io.shown[1]!.markdown).toBe(versions[2]!.markdown);

    // Submission files.
    const approved = versions[2]!;
    for (const file of Object.values(approved.exports!)) await access(file);
    expect(await readFile(approved.exports!.markdown, 'utf8')).toBe(approved.markdown);
    expect((await readFile(approved.exports!.pdf!)).subarray(0, 4).toString()).toBe('%PDF');

    // The approved CV cites only entries present in the exact profile snapshot it was written from.
    const snapshot = (await store.getProfileAtRevision(approved.profileRevision))!;
    const cited = approved.document.sections.flatMap((s) => s.entries.flatMap((e) => e.sourceIds));
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((id) => snapshot.entries.some((e) => e.id === id))).toBe(true);

    // Audit: who did what.
    const audit = await store.readAudit();
    const actors = (action: string) => [...new Set(audit.filter((e) => e.action === action).map((e) => e.actor))];
    expect(actors('save_cv_version')).toEqual(['cv-writer']);
    expect(actors('approve_cv')).toEqual(['coordinator']);
    expect(actors('upsert_profile_entry')).toEqual(['coordinator']);
    expect(audit.every((e) => e.ok)).toBe(true);

    // The conversation is stored and can be picked up later.
    const session = (await store.getSession(summary.sessionId))!;
    expect(session.messages.filter((m) => m.role === 'user').map((m) => m.content).slice(1, 3)).toEqual([
      expect.stringContaining("I'm Alex Morgan"),
      'BSc CS at Manchester, a research internship, and a hackathon project.',
    ]);

    const later = new ScriptedModel([
      call('list_job_listings'),
      (req) => {
        expect(req.messages.length).toBeGreaterThan(session.messages.length);
        const [jobs] = resultsOf(req, 'list_job_listings').slice(-1);
        return say(`Welcome back! Your ${jobs[0].company} CV (v${jobs[0].approvedVersions[0]}) is approved.`);
      },
    ]);
    const resumedIo = new ScriptedIO([null]);
    await startSession({ store, io: resumedIo, client: later, model: 'coordinator-model', writerModel: 'writer-model', resume: 'latest' });
    expect(resumedIo.said).toEqual(['Welcome back! Your Acme Health CV (v3) is approved.']);
  });
});
