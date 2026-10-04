import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createCvTools } from '../../src/agents/tools.js';
import { chromePdfRenderer, findChrome } from '../../src/cv/export.js';
import { resultJson, resultText, sampleCv, sampleJob, sampleProfile, tempStore } from '../helpers.js';

const chrome = await findChrome();

/**
 * The whole lifecycle at the tool layer: profile built up over several calls, a job
 * saved, a failing draft, a revision, approval with real file exports, and the
 * records needed to audit it afterwards.
 */
describe('CV lifecycle', () => {
  it.each([
    ['with a stub PDF renderer', false],
    ['with headless Chrome', true],
  ] as const)('%s', async (_label, realChrome) => {
    if (realChrome && !chrome) return; // no browser on this machine
    const store = await tempStore();
    const pdf = realChrome
      ? chromePdfRenderer(chrome!)
      : async (_html: string, out: string) => {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(out, '%PDF-stub');
        };
    const tools = createCvTools(store, { pdf });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      tools.find((t) => t.definition.name === name)!.definition.handler(args, {});

    // 1. Profile, collected piece by piece as a conversation would.
    const p = sampleProfile();
    await call('update_contact', p.contact);
    await call('set_headline', { headline: p.headline });
    const ids: Record<string, string> = {};
    for (const { id, ...entry } of p.entries) {
      ids[id] = resultJson(await call('upsert_profile_entry', entry)).entry.id;
    }
    for (const group of p.skills) await call('add_skills', group);
    await call('add_facts', { facts: p.facts });
    const completeness = resultJson(await call('get_profile')).completeness;
    expect(completeness).toEqual({ complete: true, missing: [] });

    // 2. Job listing.
    const { jobId } = resultJson(await call('save_job_listing', sampleJob()));

    // 3. First draft: a placeholder and an invented figure.
    const v1doc = sampleCv();
    for (const s of v1doc.sections) for (const e of s.entries) e.sourceIds = e.sourceIds.map((id) => ids[id]!);
    v1doc.contactLine.push('[LinkedIn]');
    v1doc.sections[1]!.entries[0]!.bullets.push('Mentored 14 junior researchers.');
    const v1 = resultJson(await call('save_cv_version', { jobId, document: v1doc, changeSummary: 'First draft' }));
    expect(v1.verificationPassed).toBe(false);
    expect(v1.issues.map((i: { code: string }) => i.code).sort()).toEqual(['placeholder', 'unverified-number']);

    const refused = await call('approve_cv', { jobId, version: 1 });
    expect(refused.isError).toBe(true);

    // 4. Revision addressing the user's feedback.
    const v2doc = structuredClone(v1doc);
    v2doc.contactLine.pop();
    v2doc.sections[1]!.entries[0]!.bullets.pop();
    const v2 = resultJson(
      await call('save_cv_version', {
        jobId,
        document: v2doc,
        changeSummary: 'Removed placeholder and unconfirmed mentoring claim',
        basedOnVersion: 1,
        feedback: "I don't have a LinkedIn, and I never mentored anyone.",
      }),
    );
    expect(v2).toMatchObject({ version: 2, verificationPassed: true, issues: [] });

    // 5. Approval exports submission files.
    const approved = resultJson(await call('approve_cv', { jobId, version: 2 }));
    for (const file of Object.values<string>(approved.files)) await access(file);
    expect(await readFile(approved.files.markdown, 'utf8')).toBe((await store.getCvVersion(jobId, 2))!.markdown);
    expect((await readFile(approved.files.pdf)).subarray(0, 4).toString()).toBe('%PDF');
    expect(approved.warnings).toEqual([]);

    // 6. Audit: the approved CV traces back to the exact profile snapshot it was written from,
    //    even after the profile keeps growing.
    await call('add_facts', { facts: ['Learning Kubernetes'] });
    const final = (await store.getCvVersion(jobId, 2))!;
    expect(final).toMatchObject({ status: 'approved', basedOnVersion: 1, feedback: expect.stringContaining('LinkedIn') });
    const snapshot = (await store.getProfileAtRevision(final.profileRevision))!;
    expect(snapshot.facts).not.toContain('Learning Kubernetes');
    const cited = final.document.sections.flatMap((s) => s.entries.flatMap((e) => e.sourceIds));
    expect(cited.every((id) => snapshot.entries.some((e) => e.id === id))).toBe(true);

    const history = resultText(await call('list_cv_versions', { jobId }));
    expect(resultJson({ content: [{ type: 'text', text: history }] }).map((v: { status: string }) => v.status)).toEqual(['draft', 'approved']);

    const audit = await store.readAudit();
    expect(audit.filter((e) => e.action === 'approve_cv').map((e) => e.ok)).toEqual([false, true]);
    expect(audit.filter((e) => e.action === 'save_cv_version').map((e) => e.actor)).toEqual(['cv-writer', 'cv-writer']);
  });
});
