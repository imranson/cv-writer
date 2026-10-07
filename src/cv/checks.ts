import { allSkills, profileText } from '../domain/profile.js';
import type { Check, CheckReport, CvDocument, Job, Profile } from '../domain/schemas.js';
import { extractNumbers, normaliseTerm, wordCount } from '../util/text.js';

const PLACEHOLDER = /\[[^\]\n]{0,40}\]|\{\{[^}]*\}\}|<[a-z ]*(insert|your|add)[^>]*>|\bTODO\b|\bTBD\b|lorem ipsum|\bX{2,}\b|\?\?\?/i;

/** All the visible text of a CV, section by section, with a location label for each piece. */
export function cvTextParts(doc: CvDocument): Array<{ location: string; text: string; sources: string[] }> {
  const parts: Array<{ location: string; text: string; sources: string[] }> = [];
  parts.push({ location: 'header', text: [doc.name, doc.headline].filter(Boolean).join(' — '), sources: [] });
  if (doc.summary) parts.push({ location: 'summary', text: doc.summary, sources: [] });
  for (const section of doc.sections) {
    if (section.kind === 'entries') {
      for (const item of section.items) {
        const at = `${section.title} › ${item.heading}`;
        parts.push({ location: at, text: [item.heading, item.subheading, item.location].filter(Boolean).join(' '), sources: item.sources });
        if (item.summary) parts.push({ location: at, text: item.summary, sources: item.sources });
        item.bullets.forEach((b, j) =>
          parts.push({
            location: `${at} › bullet ${j + 1}`,
            text: b.text,
            sources: b.sources.length ? b.sources : item.sources,
          }),
        );
      }
    } else if (section.kind === 'skills') {
      for (const g of section.groups) parts.push({ location: section.title, text: [g.label, ...g.items].filter(Boolean).join(', '), sources: [] });
    } else {
      parts.push({ location: section.title, text: section.text, sources: section.sources });
    }
  }
  return parts;
}

export function cvPlainText(doc: CvDocument): string {
  const dates = doc.sections.flatMap((s) => (s.kind === 'entries' ? s.items.map((i) => i.dates ?? '') : []));
  return [...cvTextParts(doc).map((p) => p.text), ...dates].join('\n');
}

const STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'via', 'ltd', 'inc', 'plc', 'llc', 'limited', 'co']);

/** True when every significant word of `text` occurs in `source` (so rewording order or case is fine, new words are not). */
export function wordsSupported(text: string, source: string): boolean {
  const have = new Set(normaliseTerm(source).split(/\s+/));
  return normaliseTerm(text)
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
    .every((w) => have.has(w) || have.has(w.replace(/s$/, '')) || have.has(`${w}s`));
}

function termIn(term: string, haystack: string): boolean {
  const t = normaliseTerm(term);
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack);
}

/**
 * Deterministic checks run on every saved CV. Errors are "complete mistakes" that block approval;
 * warnings are worth a look; info is context for the writer and critic.
 */
export function checkCv(doc: CvDocument, profile: Profile, job?: Job): CheckReport {
  const checks: Check[] = [];
  const add = (severity: Check['severity'], id: string, message: string, location?: string) =>
    checks.push({ id, severity, message, ...(location ? { location } : {}) });

  const entryIds = new Map(profile.entries.map((e) => [e.id, e]));
  const parts = cvTextParts(doc);

  // Identity must match the profile exactly.
  const c = profile.contact;
  if (c.name && doc.name.trim().toLowerCase() !== c.name.trim().toLowerCase())
    add('error', 'name-mismatch', `Name "${doc.name}" does not match the profile ("${c.name}").`, 'header');
  if (doc.contact.email && doc.contact.email.trim().toLowerCase() !== (c.email ?? '').trim().toLowerCase())
    add('error', 'email-mismatch', `Email "${doc.contact.email}" is not the profile email (${c.email ?? 'none recorded'}).`, 'header');
  if (doc.contact.phone && doc.contact.phone.replace(/\D/g, '') !== (c.phone ?? '').replace(/\D/g, ''))
    add('error', 'phone-mismatch', `Phone "${doc.contact.phone}" is not the profile phone (${c.phone ?? 'none recorded'}).`, 'header');
  if (!doc.contact.email && c.email) add('warning', 'missing-email', 'The CV has no email address; recruiters need a way to reach the candidate.', 'header');
  for (const link of doc.contact.links)
    if (!c.links.some((l) => l.replace(/\/+$/, '').toLowerCase() === link.replace(/\/+$/, '').toLowerCase()))
      add('error', 'unknown-link', `Link "${link}" is not in the profile.`, 'header');

  // Every entry item must be traceable to profile entries.
  for (const section of doc.sections) {
    if (section.kind === 'entries') {
      if (section.items.length === 0) add('error', 'empty-section', `Section "${section.title}" has no items.`, section.title);
      for (const item of section.items) {
        const at = `${section.title} › ${item.heading}`;
        if (item.sources.length === 0 && item.bullets.every((b) => b.sources.length === 0))
          add('error', 'missing-source', `"${item.heading}" does not cite the profile entry it comes from.`, at);
        const cited = [...item.sources, ...item.bullets.flatMap((b) => b.sources)];
        for (const id of new Set(cited))
          if (!entryIds.has(id)) add('error', 'unknown-source', `"${item.heading}" cites "${id}", which is not a profile entry id.`, at);
        // Titles, organisations and places must come from the cited entries, not from elsewhere.
        const citedText = cited
          .map((id) => entryIds.get(id))
          .filter((e) => e !== undefined)
          .flatMap((e) => [e.title, e.organisation, e.location, e.summary, ...e.highlights])
          .filter(Boolean)
          .join(' ');
        if (citedText) {
          const place = `${citedText} ${c.location ?? ''}`;
          for (const [field, value, source] of [
            ['title', item.heading, citedText],
            ['organisation', item.subheading, citedText],
            ['location', item.location, place],
          ] as const)
            if (value && !wordsSupported(value, source))
              add('error', 'unsupported-detail', `The ${field} "${value}" is not in the cited profile entries; use the profile's wording or add the fact to the profile first.`, at);
        }
        // Years in the dates must come from the cited entries.
        const sourceDates = cited.flatMap((id) => [entryIds.get(id)?.startDate, entryIds.get(id)?.endDate]).join(' ');
        for (const year of item.dates?.match(/\b(19|20)\d{2}\b/g) ?? [])
          if (cited.length > 0 && !sourceDates.includes(year))
            add('error', 'date-mismatch', `"${item.heading}" shows ${year}, which is not in the cited entry's dates.`, at);
        item.bullets.forEach((b, j) => {
          const words = wordCount(b.text);
          if (words > 45) add('warning', 'long-bullet', `Bullet ${j + 1} is ${words} words; aim for under 35.`, at);
        });
      }
    } else if (section.kind === 'skills') {
      if (section.groups.every((g) => g.items.length === 0)) add('error', 'empty-section', `Section "${section.title}" is empty.`, section.title);
      const known = allSkills(profile).map(normaliseTerm);
      const knownText = normaliseTerm(profileText(profile));
      for (const g of section.groups)
        for (const skill of g.items)
          if (!known.includes(normaliseTerm(skill)) && !termIn(skill, knownText))
            add('warning', 'unknown-skill', `Skill "${skill}" is not in the profile.`, section.title);
    } else if (!section.text.trim()) {
      add('error', 'empty-section', `Section "${section.title}" is empty.`, section.title);
    }
  }

  // Placeholders, invented numbers and duplicates.
  const sourceText = profileText(profile);
  const profileNumbers = new Set(extractNumbers(sourceText));
  const seen = new Map<string, string>();
  for (const part of parts) {
    const placeholder = PLACEHOLDER.exec(part.text);
    if (placeholder) add('error', 'placeholder', `Placeholder text "${placeholder[0]}" must be replaced with real content.`, part.location);
    for (const n of extractNumbers(part.text))
      if (!profileNumbers.has(n))
        add('error', 'unsupported-number', `"${n}" does not appear anywhere in the profile; numbers must come from the user.`, part.location);
    const key = part.text.trim().toLowerCase();
    if (key.length > 20) {
      const first = seen.get(key);
      if (first) add('warning', 'duplicate-text', `Repeats text already used in ${first}.`, part.location);
      else seen.set(key, part.location);
    }
  }

  const text = cvPlainText(doc);
  const words = wordCount(text);
  if (words > 950) add('warning', 'too-long', `About ${words} words — likely more than two pages. Trim older or less relevant content.`);
  if (words < 120) add('warning', 'too-short', `Only about ${words} words — the CV looks thin.`);
  if (!doc.sections.some((s) => s.kind === 'entries')) add('error', 'no-experience', 'The CV has no experience, education or project entries.');

  // Job keyword coverage (informational; the critic judges relevance).
  const haystack = normaliseTerm(text);
  const keywords = job?.keywords ?? [];
  const matched = keywords.filter((k) => termIn(k, haystack));
  const missing = keywords.filter((k) => !termIn(k, haystack));
  if (keywords.length)
    add(
      'info',
      'keyword-coverage',
      `${matched.length}/${keywords.length} job keywords appear in the CV.${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}`,
    );

  return {
    checks,
    errorCount: checks.filter((x) => x.severity === 'error').length,
    warningCount: checks.filter((x) => x.severity === 'warning').length,
    wordCount: words,
    keywordCoverage: { matched, missing },
  };
}

export function formatChecks(report: CheckReport): string {
  if (report.checks.length === 0) return 'All checks passed.';
  return report.checks.map((c) => `- [${c.severity}] ${c.id}${c.location ? ` (${c.location})` : ''}: ${c.message}`).join('\n');
}
