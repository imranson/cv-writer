import { describe, expect, it } from 'vitest';
import { containsTerm, extractNumbers, verifyCv } from '../../src/cv/verify.js';
import { JobListingSchema, type CvDocument } from '../../src/domain/schemas.js';
import { sampleCv, sampleJob, sampleProfile } from '../helpers.js';

const job = JobListingSchema.parse({ ...sampleJob(), id: 'acme-1', createdAt: '2026-10-04T00:00:00Z' });
const codes = (doc: CvDocument, j = job) => verifyCv(doc, sampleProfile(), j).issues.map((i) => i.code);

function withBullet(bullet: string): CvDocument {
  const doc = sampleCv();
  doc.sections[1]!.entries[0]!.bullets.push(bullet);
  return doc;
}

describe('extractNumbers / containsTerm', () => {
  it('normalises thousands separators and suffixes', () => {
    expect(extractNumbers('122,000+ records, 50% better, 0.80 F1, team of 3')).toEqual(['122000', '50', '0.80', '3']);
  });

  it('ignores digits that are part of names', () => {
    expect(extractNumbers('Deployed on AWS S3 and EC2 with Python3; 10x faster')).toEqual(['10']);
  });

  it('matches whole terms only, case-insensitively', () => {
    expect(containsTerm('Built services in Go and Python', 'go')).toBe(true);
    expect(containsTerm('Good at algorithms', 'Go')).toBe(false);
    expect(containsTerm('Wrote C++ and Node.js', 'C++')).toBe(true);
    expect(containsTerm('Wrote C++ and Node.js', 'node.js')).toBe(true);
    expect(containsTerm('anything', '  ')).toBe(false);
  });
});

describe('verifyCv', () => {
  it('passes a grounded CV, reporting keyword coverage and stats', () => {
    const report = verifyCv(sampleCv(), sampleProfile(), job);
    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.keywordCoverage).toEqual({ matched: ['Python', 'AWS', 'machine learning'], missing: ['Kubernetes'] });
    expect(report.stats.bulletCount).toBe(4);
    expect(report.stats.wordCount).toBeGreaterThan(40);
    expect(report.stats.estimatedPages).toBeLessThan(1);
  });

  it('errors on citations of unknown profile entries', () => {
    const doc = sampleCv();
    doc.sections[1]!.entries[0]!.sourceIds = ['experience-1', 'made-up'];
    const report = verifyCv(doc, sampleProfile(), job);
    expect(report.passed).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'unknown-source' }));
  });

  it('warns about entries that cite nothing', () => {
    const doc = sampleCv();
    doc.sections[1]!.entries[0]!.sourceIds = [];
    expect(codes(doc)).toEqual(['ungrounded-entry']);
  });

  it('errors on placeholders but not on Markdown links', () => {
    const doc = sampleCv();
    doc.contactLine[0] = '[City], UK';
    const report = verifyCv(doc, sampleProfile(), job);
    expect(report.passed).toBe(false);
    expect(report.issues.map((i) => i.code)).toEqual(['placeholder']);
    expect(codes(withBullet('Shipped feature X — TODO add metric'))).toContain('placeholder');
  });

  it('errors on empty sections', () => {
    const doc = sampleCv();
    doc.sections.push({ title: 'Awards', items: [], entries: [] });
    expect(codes(doc)).toEqual(['empty-section']);
  });

  it('warns about numbers that are not in the profile', () => {
    const report = verifyCv(withBullet('Cut latency by 37% across 12 services.'), sampleProfile(), job);
    const numbers = report.issues.filter((i) => i.code === 'unverified-number').map((i) => i.message);
    expect(numbers).toHaveLength(2);
    expect(numbers[0]).toContain('"37"');
    expect(report.passed).toBe(true);
  });

  it('warns about long and duplicate bullets', () => {
    const long = Array.from({ length: 40 }, () => 'word').join(' ');
    expect(codes(withBullet(long))).toContain('long-bullet');
    const dup = sampleCv();
    const entry = dup.sections[1]!.entries[0]!;
    entry.bullets.push(entry.bullets[0]!.toUpperCase());
    expect(codes(dup)).toContain('duplicate-bullet');
  });

  it('warns when the name or email do not match the profile', () => {
    const doc = { ...sampleCv(), name: 'Alexander Morgan', contactLine: ['Manchester, UK'] };
    expect(codes(doc)).toEqual(['name-mismatch', 'missing-email']);
  });

  it('warns about CVs longer than two pages', () => {
    const doc = sampleCv();
    doc.sections[0]!.paragraph = Array.from({ length: 1100 }, () => 'word').join(' ');
    expect(codes(doc)).toContain('too-long');
  });

  it('warns about low keyword coverage and works without a job', () => {
    const lowCoverage = { ...job, keywords: ['Kubernetes', 'Terraform', 'Go'] };
    expect(codes(sampleCv(), lowCoverage)).toEqual(['low-keyword-coverage']);
    expect(verifyCv(sampleCv(), sampleProfile()).keywordCoverage).toEqual({ matched: [], missing: [] });
  });
});
