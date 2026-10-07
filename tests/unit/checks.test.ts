import { describe, expect, it } from 'vitest';
import { checkCv, cvPlainText, formatChecks, wordsSupported } from '../../src/cv/checks.js';
import { JobSchema, type CvDocument } from '../../src/domain/schemas.js';
import { CV_DOC, JOB, PROFILE } from '../support/fixtures.js';

const job = JobSchema.parse({ ...JOB, id: 'babbage-platform-abc123', createdAt: '2026-10-01T00:00:00Z' });
const ids = (doc: CvDocument) => checkCv(doc, PROFILE, job).checks.map((c) => c.id);
const clone = () => structuredClone(CV_DOC);

describe('checkCv', () => {
  it('passes a CV that is faithful to the profile', () => {
    const report = checkCv(CV_DOC, PROFILE, job);
    expect(report.errorCount).toBe(0);
    expect(report.checks.filter((c) => c.severity === 'error')).toEqual([]);
    expect(report.wordCount).toBeGreaterThan(50);
  });

  it('reports keyword coverage against the job', () => {
    const report = checkCv(CV_DOC, PROFILE, job);
    expect(report.keywordCoverage.matched).toEqual(['Python', 'AWS', 'GitHub Actions']);
    expect(report.keywordCoverage.missing).toEqual(['Terraform', 'Kubernetes']);
    expect(formatChecks(report)).toMatch(/3\/5 job keywords/);
  });

  it('catches identity mismatches', () => {
    const doc = clone();
    doc.name = 'Ada King';
    doc.contact.email = 'ada@other.com';
    doc.contact.phone = '+44 0000';
    doc.contact.links = ['linkedin.com/in/fake'];
    expect(ids(doc)).toEqual(expect.arrayContaining(['name-mismatch', 'email-mismatch', 'phone-mismatch', 'unknown-link']));
  });

  it('requires every item to cite real profile entries', () => {
    const doc = clone();
    const exp = doc.sections[0]!;
    if (exp.kind !== 'entries') throw new Error();
    exp.items[0]!.sources = [];
    expect(ids(doc)).toContain('missing-source');
    exp.items[0]!.sources = ['experience-zzz999'];
    expect(ids(doc)).toContain('unknown-source');
  });

  it('flags invented numbers but accepts numbers from the profile', () => {
    const doc = clone();
    const exp = doc.sections[0]!;
    if (exp.kind !== 'entries') throw new Error();
    exp.items[0]!.bullets.push({ text: 'Improved uptime to 99.99% for 1,000,000 users', sources: [] });
    const report = checkCv(doc, PROFILE, job);
    const numbers = report.checks.filter((c) => c.id === 'unsupported-number').map((c) => c.message);
    expect(numbers.join(' ')).toMatch(/"99\.99"/);
    expect(numbers.join(' ')).toMatch(/"1000000"/);
    expect(numbers.join(' ')).not.toMatch(/"40000"/);
  });

  it('requires titles, organisations and places to come from the cited entries', () => {
    const doc = clone();
    const edu = doc.sections[1]!;
    if (edu.kind !== 'entries') throw new Error();
    edu.items[0]!.subheading = 'University of Leeds';
    const exp = doc.sections[0]!;
    if (exp.kind !== 'entries') throw new Error();
    exp.items[0]!.heading = 'Senior Software Engineer';
    exp.items[0]!.location = 'Paris';
    const messages = checkCv(doc, PROFILE, job).checks.filter((c) => c.id === 'unsupported-detail').map((c) => c.message);
    expect(messages).toEqual([
      expect.stringMatching(/title "Senior Software Engineer"/),
      expect.stringMatching(/location "Paris"/),
      expect.stringMatching(/organisation "University of Leeds"/),
    ]);
  });

  it('accepts reordered, re-cased or abbreviated-company wording of profile facts', () => {
    expect(wordsSupported('analytical engines', 'Software Engineer Analytical Engines Ltd')).toBe(true);
    expect(wordsSupported('London, UK', 'London UK')).toBe(true);
    expect(wordsSupported('BA History (2:1)', 'BA History, 2:1')).toBe(true);
    expect(wordsSupported('Engineering Manager', 'Software Engineer')).toBe(false);
  });

  it('flags years that are not in the cited entry dates', () => {
    const doc = clone();
    const exp = doc.sections[0]!;
    if (exp.kind !== 'entries') throw new Error();
    exp.items[0]!.dates = 'Sep 2019 – Present';
    expect(ids(doc)).toContain('date-mismatch');
  });

  it('flags placeholders, empty sections and unknown skills', () => {
    const doc = clone();
    doc.summary = 'Engineer with [X years] of experience. TODO: tailor';
    doc.sections.push({ kind: 'entries', title: 'Projects', items: [] });
    doc.sections.push({ kind: 'text', title: 'Interests', text: ' ', sources: [] });
    const skills = doc.sections[2]!;
    if (skills.kind !== 'skills') throw new Error();
    skills.groups[0]!.items.push('Rust');
    const report = checkCv(doc, PROFILE, job);
    expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['placeholder', 'empty-section', 'unknown-skill']));
    expect(report.checks.find((c) => c.id === 'unknown-skill')?.severity).toBe('warning');
  });

  it('warns about long bullets, duplicates and length', () => {
    const doc = clone();
    const exp = doc.sections[0]!;
    if (exp.kind !== 'entries') throw new Error();
    exp.items[0]!.bullets.push({ text: Array(50).fill('word').join(' '), sources: [] });
    exp.items[0]!.bullets.push({ ...exp.items[0]!.bullets[0]! });
    expect(ids(doc)).toEqual(expect.arrayContaining(['long-bullet', 'duplicate-text']));
    const tiny: CvDocument = { name: 'Ada Lovelace', contact: { links: [] }, sections: [{ kind: 'text', title: 'About', text: 'Hi', sources: [] }] };
    expect(ids(tiny)).toEqual(expect.arrayContaining(['too-short', 'no-experience']));
  });

  it('includes dates in the plain text used for coverage', () => {
    expect(cvPlainText(CV_DOC)).toContain('Sep 2021 – Present');
  });
});
