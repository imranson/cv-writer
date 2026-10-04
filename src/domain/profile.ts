import type { Contact, EntrySection, Profile, ProfileEntry } from './schemas.js';

export type EntryInput = Partial<Omit<ProfileEntry, 'id'>> & { id?: string };

export function emptyProfile(now: Date = new Date()): Profile {
  return {
    revision: 0,
    updatedAt: now.toISOString(),
    contact: { links: [] },
    entries: [],
    skills: [],
    facts: [],
  };
}

const norm = (s: string) => s.trim().toLowerCase();

/** Appends items not already present (case-insensitive), preserving order. */
export function mergeUnique(existing: string[], additions: string[]): string[] {
  const seen = new Set(existing.map(norm));
  const out = [...existing];
  for (const item of additions) {
    const trimmed = item.trim();
    if (trimmed && !seen.has(norm(trimmed))) {
      seen.add(norm(trimmed));
      out.push(trimmed);
    }
  }
  return out;
}

export function mergeContact(profile: Profile, patch: Partial<Contact>): Profile {
  const { links, ...rest } = patch;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return {
    ...profile,
    contact: {
      ...profile.contact,
      ...defined,
      links: links ? mergeUnique(profile.contact.links, links) : profile.contact.links,
    },
  };
}

/**
 * Creates an entry (no id, or unknown id) or updates the matching one. Fields
 * provided on update replace the stored values; omitted fields are kept.
 */
export function upsertEntry(
  profile: Profile,
  input: EntryInput,
  genId: (section: EntrySection) => string,
): { profile: Profile; entry: ProfileEntry; created: boolean } {
  const defined = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as EntryInput;
  const index = defined.id ? profile.entries.findIndex((e) => e.id === defined.id) : -1;

  if (index >= 0) {
    const entry = { ...profile.entries[index]!, ...defined } as ProfileEntry;
    const entries = profile.entries.with(index, entry);
    return { profile: { ...profile, entries }, entry, created: false };
  }

  if (!defined.section) throw new Error('section is required when creating a profile entry');
  if (!defined.title?.trim()) throw new Error('title is required when creating a profile entry');
  const entry: ProfileEntry = {
    highlights: [],
    skills: [],
    ...defined,
    id: defined.id ?? genId(defined.section),
    section: defined.section,
    title: defined.title.trim(),
  };
  return { profile: { ...profile, entries: [...profile.entries, entry] }, entry, created: true };
}

export function addHighlights(profile: Profile, entryId: string, highlights: string[]): Profile {
  const index = profile.entries.findIndex((e) => e.id === entryId);
  if (index < 0) throw new Error(`No profile entry with id "${entryId}"`);
  const entry = profile.entries[index]!;
  const entries = profile.entries.with(index, {
    ...entry,
    highlights: mergeUnique(entry.highlights, highlights),
  });
  return { ...profile, entries };
}

export function removeEntry(profile: Profile, entryId: string): Profile {
  if (!profile.entries.some((e) => e.id === entryId)) {
    throw new Error(`No profile entry with id "${entryId}"`);
  }
  return { ...profile, entries: profile.entries.filter((e) => e.id !== entryId) };
}

export function mergeSkills(profile: Profile, category: string, items: string[]): Profile {
  const index = profile.skills.findIndex((g) => norm(g.category) === norm(category));
  if (index < 0) {
    return { ...profile, skills: [...profile.skills, { category: category.trim(), items: mergeUnique([], items) }] };
  }
  const group = profile.skills[index]!;
  return { ...profile, skills: profile.skills.with(index, { ...group, items: mergeUnique(group.items, items) }) };
}

export function addFacts(profile: Profile, facts: string[]): Profile {
  return { ...profile, facts: mergeUnique(profile.facts, facts) };
}

export interface Completeness {
  complete: boolean;
  missing: string[];
}

/** What the coordinator still needs before a strong CV can be written. */
export function profileCompleteness(profile: Profile): Completeness {
  const missing: string[] = [];
  const has = (section: EntrySection) => profile.entries.some((e) => e.section === section);

  if (!profile.contact.name) missing.push('full name');
  if (!profile.contact.email) missing.push('email address');
  if (!profile.contact.phone) missing.push('phone number');
  if (!profile.contact.location) missing.push('location (city, country)');
  if (!profile.headline) missing.push('career goal / target role');
  if (!has('education')) missing.push('education');
  if (!has('experience') && !has('project')) missing.push('work experience or projects');
  if (profile.skills.length === 0) missing.push('skills');
  const thin = profile.entries.filter(
    (e) => (e.section === 'experience' || e.section === 'project') && e.highlights.length === 0,
  );
  for (const e of thin) missing.push(`achievements for "${e.title}" (${e.id})`);

  return { complete: missing.length === 0, missing };
}

/** All profile text, used to check that CV claims are grounded. */
export function profileCorpus(profile: Profile): string {
  const parts: string[] = [
    ...Object.values(profile.contact).flat().filter((v): v is string => typeof v === 'string'),
    profile.headline ?? '',
    ...profile.facts,
  ];
  for (const e of profile.entries) {
    parts.push(e.title, e.organisation ?? '', e.location ?? '', e.startDate ?? '', e.endDate ?? '', e.summary ?? '');
    parts.push(...e.highlights, ...e.skills);
  }
  for (const g of profile.skills) parts.push(g.category, ...g.items);
  return parts.filter(Boolean).join('\n');
}
