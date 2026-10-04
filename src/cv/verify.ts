import { profileCorpus } from '../domain/profile.js';
import type {
  CvDocument,
  JobListing,
  Profile,
  VerificationIssue,
  VerificationReport,
} from '../domain/schemas.js';
import { plainText } from './render.js';

export const LIMITS = {
  maxBulletWords: 35,
  maxPages: 2,
  wordsPerPage: 500,
  minKeywordCoverage: 0.5,
};

// Digits glued to a preceding letter are names (F1, S3, EC2), not claims.
const NUMBER = /(?<![A-Za-z])\d+(?:[.,]\d+)*/g;
const PLACEHOLDER = /\[[^\]]*\](?!\()|\b(?:TODO|TBD|XXX+)\b|lorem ipsum|\?\?\?/i;

/** Numbers as they appear in prose, normalised so "122,000+" and "122000" compare equal. */
export function extractNumbers(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(/,/g, ''));
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function containsTerm(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return new RegExp(`(?<![a-z0-9])${escapeRegex(t)}(?![a-z0-9])`, 'i').test(text);
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** All prose in the document paired with where it came from, for targeted messages. */
function textUnits(doc: CvDocument): Array<{ where: string; text: string }> {
  const units = [
    { where: 'name', text: doc.name },
    ...doc.contactLine.map((text) => ({ where: 'contact line', text })),
  ];
  for (const s of doc.sections) {
    units.push({ where: `section "${s.title}" title`, text: s.title });
    if (s.paragraph) units.push({ where: `section "${s.title}"`, text: s.paragraph });
    s.items.forEach((text) => units.push({ where: `section "${s.title}"`, text }));
    for (const e of s.entries) {
      const where = `entry "${e.heading}"`;
      units.push({ where, text: e.heading });
      if (e.subheading) units.push({ where, text: e.subheading });
      if (e.dates) units.push({ where, text: e.dates });
      e.bullets.forEach((text) => units.push({ where, text }));
    }
  }
  return units;
}

/**
 * Deterministic checks run on every saved CV version. Errors block approval;
 * warnings are surfaced to the writer and the user.
 */
export function verifyCv(doc: CvDocument, profile: Profile, job?: JobListing): VerificationReport {
  const issues: VerificationIssue[] = [];
  const error = (code: string, message: string) => issues.push({ severity: 'error', code, message });
  const warn = (code: string, message: string) => issues.push({ severity: 'warning', code, message });

  const entryIds = new Set(profile.entries.map((e) => e.id));
  const corpus = profileCorpus(profile);
  const knownNumbers = new Set(extractNumbers(corpus));

  for (const section of doc.sections) {
    if (!section.paragraph?.trim() && section.items.length === 0 && section.entries.length === 0) {
      error('empty-section', `Section "${section.title}" has no content.`);
    }
    for (const entry of section.entries) {
      if (entry.sourceIds.length === 0) {
        warn('ungrounded-entry', `Entry "${entry.heading}" does not cite any profile entry (sourceIds).`);
      }
      for (const id of entry.sourceIds) {
        if (!entryIds.has(id)) error('unknown-source', `Entry "${entry.heading}" cites unknown profile entry "${id}".`);
      }
      const seen = new Set<string>();
      for (const bullet of entry.bullets) {
        if (wordCount(bullet) > LIMITS.maxBulletWords) {
          warn('long-bullet', `A bullet in "${entry.heading}" exceeds ${LIMITS.maxBulletWords} words: "${bullet.slice(0, 60)}…"`);
        }
        if (seen.has(norm(bullet))) warn('duplicate-bullet', `Duplicate bullet in "${entry.heading}".`);
        seen.add(norm(bullet));
      }
    }
  }

  const unverified = new Map<string, string>();
  for (const { where, text } of textUnits(doc)) {
    const placeholder = text.match(PLACEHOLDER);
    if (placeholder) error('placeholder', `Placeholder "${placeholder[0]}" in ${where} must be filled in or removed.`);
    for (const n of extractNumbers(text)) {
      if (!knownNumbers.has(n) && !unverified.has(n)) unverified.set(n, where);
    }
  }
  for (const [n, where] of unverified) {
    warn('unverified-number', `"${n}" in ${where} does not appear anywhere in the profile — confirm it with the user or remove it.`);
  }

  const { name, email } = profile.contact;
  if (name && norm(name) !== norm(doc.name)) warn('name-mismatch', `CV name "${doc.name}" differs from profile name "${name}".`);
  if (email && !doc.contactLine.some((c) => c.toLowerCase().includes(email.toLowerCase()))) {
    warn('missing-email', `Profile email ${email} is not in the contact line.`);
  }

  const text = plainText(doc);
  const words = wordCount(text);
  const estimatedPages = Math.round((words / LIMITS.wordsPerPage) * 10) / 10;
  if (estimatedPages > LIMITS.maxPages) {
    warn('too-long', `About ${estimatedPages} pages (${words} words); aim for ${LIMITS.maxPages} pages or fewer.`);
  }

  const keywords = job?.keywords ?? [];
  const matched = keywords.filter((k) => containsTerm(text, k));
  const missing = keywords.filter((k) => !containsTerm(text, k));
  if (keywords.length && matched.length / keywords.length < LIMITS.minKeywordCoverage) {
    warn('low-keyword-coverage', `Only ${matched.length}/${keywords.length} job keywords appear. Missing: ${missing.join(', ')}.`);
  }

  const bulletCount = doc.sections.reduce(
    (n, s) => n + s.items.length + s.entries.reduce((m, e) => m + e.bullets.length, 0),
    0,
  );

  return {
    passed: !issues.some((i) => i.severity === 'error'),
    issues,
    keywordCoverage: { matched, missing },
    stats: { wordCount: words, bulletCount, estimatedPages },
  };
}
