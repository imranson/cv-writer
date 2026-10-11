import { htmlToText, stripTags, wordCount } from '../util/text.ts';

export type CheckSeverity = 'error' | 'warning' | 'info';

export interface CheckFinding {
  id: string;
  severity: CheckSeverity;
  message: string;
  detail?: string;
}

export interface CheckOptions {
  /** Candidate profile markdown — the source of truth for facts. */
  profile: string;
  pageCount?: number;
  maxPages?: number;
}

const PLACEHOLDER = /\[(?:[A-Za-z][^\]\n]{0,40})\]|\{\{[^}]*\}\}|\b(?:TODO|TBD|TBC|lorem ipsum|XXX+|your name|company name)\b/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const URL_LIKE = /\b(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com)\/[\w\-/.%]+/gi;
const NUMBER = /(?:[£$€]\s?)?\d[\d,]*(?:\.\d+)?\s?(?:%|k\b|m\b|bn\b|x\b|\+)?/gi;
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';

function matchAll(html: string, re: RegExp): string[] {
  return [...html.matchAll(re)].map((m) => m[1] ?? '');
}

/** Body of the CV without the <header> (contact details contain numbers that are not "metrics"). */
function withoutHeader(html: string): string {
  return html.replace(/<header\b[\s\S]*?<\/header>/i, '');
}

function headerText(html: string): string {
  const m = html.match(/<header\b[\s\S]*?<\/header>/i);
  return m ? stripTags(m[0]) : '';
}

function normaliseNumber(raw: string): string {
  return raw.replace(/[£$€\s,+]/g, '').replace(/(%|k|m|bn|x)$/i, '');
}

function profileContainsNumber(profile: string, num: string): boolean {
  if (!num) return true;
  const haystack = profile.replace(/(\d),(\d{3})/g, '$1$2');
  const escaped = num.replace(/\./g, '\\.');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d]|\\.\\d)`).test(haystack);
}

/** Reads a page limit like "max 2 pages", "one-page CV", "1 page" from the profile; defaults to 2. */
export function preferredMaxPages(profile: string): number {
  const words: Record<string, number> = { one: 1, two: 2, three: 3 };
  const m = profile.match(/\b(\d|one|two|three)[\s-]*pages?\b/i);
  if (!m?.[1]) return 2;
  const v = words[m[1].toLowerCase()] ?? Number(m[1]);
  return v >= 1 && v <= 4 ? v : 2;
}

export function extractBullets(html: string): string[] {
  return matchAll(html, /<li\b[^>]*>([\s\S]*?)<\/li>/gi).map(stripTags).filter(Boolean);
}

export function runChecks(html: string, opts: CheckOptions): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const add = (f: CheckFinding) => findings.push(f);
  const text = htmlToText(html);

  if (!text.trim()) {
    return [{ id: 'empty', severity: 'error', message: 'The CV is empty.' }];
  }

  if (/<script\b|\son\w+\s*=|javascript:/i.test(html)) {
    add({ id: 'unsafe-markup', severity: 'error', message: 'The CV contains scripts or event handlers.' });
  }

  if (!/<h1\b/i.test(html)) {
    add({ id: 'missing-name', severity: 'error', message: 'No name heading (<h1>) at the top of the CV.' });
  }

  const head = headerText(html) || text.slice(0, 400);
  const hasEmail = new RegExp(EMAIL.source).test(head);
  const hasPhone = PHONE.test(head);
  if (!hasEmail && !hasPhone) {
    add({ id: 'missing-contact', severity: 'error', message: 'No email address or phone number in the CV header.' });
  } else if (!hasEmail) {
    add({ id: 'missing-email', severity: 'warning', message: 'No email address in the CV header.' });
  }

  const placeholders = [...new Set(text.match(PLACEHOLDER) ?? [])];
  if (placeholders.length) {
    add({
      id: 'placeholder',
      severity: 'error',
      message: `Placeholder text left in the CV: ${placeholders.slice(0, 5).join(', ')}`,
    });
  }

  if (!/<h2\b[^>]*>[^<]*(experience|employment|work history|career)/i.test(html)) {
    add({ id: 'no-experience', severity: 'warning', message: 'No "Experience" section heading found.' });
  }

  // Facts: every number/metric and contact handle should come from the profile.
  const profile = opts.profile;
  const bodyText = stripTags(withoutHeader(html));
  const unverified = new Set<string>();
  for (const raw of bodyText.match(NUMBER) ?? []) {
    const n = normaliseNumber(raw.trim());
    if (/^\d$/.test(n)) continue; // single digits ("3 teams") are too noisy to verify
    if (!profileContainsNumber(profile, n)) unverified.add(raw.trim());
  }
  if (unverified.size) {
    add({
      id: 'unverified-number',
      severity: 'warning',
      message: `Numbers not found in the profile — confirm they are true: ${[...unverified].slice(0, 8).join(', ')}`,
    });
  }
  const contacts = [...(text.match(EMAIL) ?? []), ...(text.match(URL_LIKE) ?? [])];
  const profileLower = profile.toLowerCase();
  const unknownContacts = [...new Set(contacts)].filter(
    (c) => !profileLower.includes(c.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/[./]+$/, '')),
  );
  if (unknownContacts.length) {
    add({
      id: 'unverified-contact',
      severity: 'error',
      message: `Contact details not in the profile (possibly invented): ${unknownContacts.join(', ')}`,
    });
  }

  const bullets = extractBullets(withoutHeader(html));
  const seen = new Map<string, number>();
  for (const b of bullets) {
    const key = b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([k, n]) => n > 1 && k.split(' ').length > 2);
  if (dupes.length) {
    add({ id: 'duplicate-bullet', severity: 'warning', message: `Duplicate bullet points (${dupes.length}).`, detail: dupes.map(([k]) => k).join('\n') });
  }
  const long = bullets.filter((b) => wordCount(b) > 45);
  if (long.length) {
    add({ id: 'long-bullet', severity: 'warning', message: `${long.length} bullet point(s) over 45 words — tighten them.`, detail: long.join('\n') });
  }
  const firstPerson = bullets.filter((b) => /(^|\s)(I|my|me)(\s|$|')/.test(b));
  if (firstPerson.length) {
    add({
      id: 'first-person',
      severity: 'warning',
      message: `${firstPerson.length} bullet(s) use first person ("I", "my") — CV bullets normally omit pronouns.`,
      detail: firstPerson.join('\n'),
    });
  }

  const repeated = [...text.matchAll(/\b([a-z]{2,})\s+\1\b/gi)].map((m) => m[0]);
  if (repeated.length) {
    add({ id: 'repeated-word', severity: 'warning', message: `Repeated words: ${[...new Set(repeated)].join(', ')}` });
  }

  const monthYear = new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+\\d{4}\\b`, 'i').test(bodyText);
  const numericDate = /\b\d{1,2}\/\d{4}\b/.test(bodyText);
  if (monthYear && numericDate) {
    add({ id: 'date-format', severity: 'warning', message: 'Mixed date formats (e.g. "Jan 2020" and "01/2020") — use one style.' });
  }

  const words = wordCount(text);
  if (words > 1000) {
    add({ id: 'too-long', severity: 'warning', message: `${words} words — likely too long; aim for under ~900 for two pages.` });
  } else if (words < 150) {
    add({ id: 'too-short', severity: 'warning', message: `Only ${words} words — the CV looks thin.` });
  }

  const maxPages = opts.maxPages ?? preferredMaxPages(profile);
  if (opts.pageCount !== undefined) {
    if (opts.pageCount > maxPages) {
      add({ id: 'page-count', severity: 'error', message: `The PDF is ${opts.pageCount} pages; the limit is ${maxPages}.` });
    } else {
      add({ id: 'page-count', severity: 'info', message: `The PDF is ${opts.pageCount} page(s) (limit ${maxPages}).` });
    }
  }

  add({ id: 'word-count', severity: 'info', message: `${words} words, ${bullets.length} bullet points.` });
  return findings;
}

export function hasBlockingFindings(findings: CheckFinding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}
