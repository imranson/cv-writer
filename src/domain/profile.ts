import { shortId } from '../util/ids.js';
import { extractNumbers } from '../util/text.js';
import {
  ProfileEntrySchema,
  type Contact,
  type EntrySection,
  type Profile,
  type ProfileEntry,
} from './schemas.js';

export function emptyProfile(now = new Date().toISOString()): Profile {
  return { revision: 0, updatedAt: now, contact: { links: [] }, entries: [], skills: [], facts: [] };
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function dedupe(items: string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (item && !out.some((o) => sameText(o, item))) out.push(item);
  }
  return out;
}

export class ProfileError extends Error {}

export function updateContact(profile: Profile, patch: Partial<Contact>): Profile {
  const contact: Contact = { ...profile.contact };
  for (const key of ['name', 'email', 'phone', 'location'] as const) {
    const value = patch[key];
    if (value !== undefined) {
      if (value.trim()) contact[key] = value.trim();
      else delete contact[key];
    }
  }
  if (patch.links) contact.links = dedupe(patch.links);
  return { ...profile, contact };
}

export function setHeadline(profile: Profile, headline: string): Profile {
  const next = { ...profile };
  if (headline.trim()) next.headline = headline.trim();
  else delete next.headline;
  return next;
}

export type EntryInput = Omit<ProfileEntry, 'id' | 'highlights' | 'skills'> & {
  highlights?: string[];
  skills?: string[];
};

export function addEntry(profile: Profile, input: EntryInput, id = `${input.section}-${shortId()}`): {
  profile: Profile;
  entry: ProfileEntry;
} {
  const entry = ProfileEntrySchema.parse({
    ...input,
    id,
    highlights: dedupe(input.highlights ?? []),
    skills: dedupe(input.skills ?? []),
  });
  return { profile: { ...profile, entries: [...profile.entries, entry] }, entry };
}

export interface EntryPatch {
  section?: EntrySection;
  title?: string;
  organisation?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  summary?: string;
  /** Replaces all highlights. */
  highlights?: string[];
  addHighlights?: string[];
  /** Highlights to remove, by exact text or 1-based position. */
  removeHighlights?: Array<string | number>;
  skills?: string[];
  addSkills?: string[];
}

export function getEntry(profile: Profile, id: string): ProfileEntry {
  const entry = profile.entries.find((e) => e.id === id);
  if (!entry) {
    const known = profile.entries.map((e) => e.id).join(', ') || 'none';
    throw new ProfileError(`No profile entry with id "${id}". Known ids: ${known}`);
  }
  return entry;
}

export function updateEntry(profile: Profile, id: string, patch: EntryPatch): { profile: Profile; entry: ProfileEntry } {
  const current = getEntry(profile, id);
  const next: ProfileEntry = { ...current };
  for (const key of ['section', 'title', 'organisation', 'location', 'startDate', 'endDate', 'summary'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (key === 'section') next.section = value as EntrySection;
    else if (key === 'title') {
      if (!value.trim()) throw new ProfileError('title cannot be empty');
      next.title = value.trim();
    } else if (value.trim()) next[key] = value.trim();
    else delete next[key];
  }
  let highlights = patch.highlights ? dedupe(patch.highlights) : [...current.highlights];
  if (patch.removeHighlights?.length) {
    const drop = new Set<number>();
    for (const r of patch.removeHighlights) {
      const index = typeof r === 'number' ? r - 1 : highlights.findIndex((h) => sameText(h, r));
      if (index < 0 || index >= highlights.length) throw new ProfileError(`Highlight to remove not found: ${String(r)}`);
      drop.add(index);
    }
    highlights = highlights.filter((_, i) => !drop.has(i));
  }
  if (patch.addHighlights) highlights = dedupe([...highlights, ...patch.addHighlights]);
  next.highlights = highlights;
  let skills = patch.skills ? dedupe(patch.skills) : [...current.skills];
  if (patch.addSkills) skills = dedupe([...skills, ...patch.addSkills]);
  next.skills = skills;
  const entry = ProfileEntrySchema.parse(next);
  return { profile: { ...profile, entries: profile.entries.map((e) => (e.id === id ? entry : e)) }, entry };
}

export function removeEntry(profile: Profile, id: string): Profile {
  getEntry(profile, id);
  return { ...profile, entries: profile.entries.filter((e) => e.id !== id) };
}

export function addSkills(profile: Profile, category: string, items: string[]): Profile {
  const cat = category.trim() || 'Skills';
  const existing = profile.skills.find((g) => sameText(g.category, cat));
  const skills = existing
    ? profile.skills.map((g) => (g === existing ? { category: g.category, items: dedupe([...g.items, ...items]) } : g))
    : [...profile.skills, { category: cat, items: dedupe(items) }];
  return { ...profile, skills: skills.filter((g) => g.items.length > 0) };
}

export function removeSkills(profile: Profile, items: string[]): Profile {
  const skills = profile.skills
    .map((g) => ({ category: g.category, items: g.items.filter((i) => !items.some((r) => sameText(r, i))) }))
    .filter((g) => g.items.length > 0);
  return { ...profile, skills };
}

export function addFacts(profile: Profile, facts: string[]): Profile {
  return { ...profile, facts: dedupe([...profile.facts, ...facts]) };
}

export function removeFacts(profile: Profile, facts: Array<string | number>): Profile {
  const drop = new Set<number>();
  for (const f of facts) {
    const index = typeof f === 'number' ? f - 1 : profile.facts.findIndex((x) => sameText(x, f));
    if (index < 0 || index >= profile.facts.length) throw new ProfileError(`Fact to remove not found: ${String(f)}`);
    drop.add(index);
  }
  return { ...profile, facts: profile.facts.filter((_, i) => !drop.has(i)) };
}

/** Every skill the user has claimed, in profile skill groups or on entries. */
export function allSkills(profile: Profile): string[] {
  return dedupe([...profile.skills.flatMap((g) => g.items), ...profile.entries.flatMap((e) => e.skills)]);
}

/** All the profile's text, used to check that a CV does not state facts the user never gave. */
export function profileText(profile: Profile): string {
  const c = profile.contact;
  return [
    c.name,
    c.email,
    c.phone,
    c.location,
    ...c.links,
    profile.headline,
    ...profile.entries.flatMap((e) => [e.title, e.organisation, e.location, e.startDate, e.endDate, e.summary, ...e.highlights, ...e.skills]),
    ...profile.skills.flatMap((g) => [g.category, ...g.items]),
    ...profile.facts,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Gaps the coordinator should proactively ask about. Deterministic, so the agent gets the same
 * prompts whatever model it runs on.
 */
export function profileGaps(profile: Profile): string[] {
  const gaps: string[] = [];
  const c = profile.contact;
  if (!c.name) gaps.push('Full name is missing.');
  if (!c.email) gaps.push('Email address is missing.');
  if (!c.phone) gaps.push('Phone number is missing (optional, but most CVs include one).');
  if (!c.location) gaps.push('Location (city/country) is missing.');
  if (!profile.headline) gaps.push('Career goal / target roles are unknown.');
  const sections = new Set(profile.entries.map((e) => e.section));
  if (!sections.has('experience')) gaps.push('No work experience recorded (jobs, internships, part-time work).');
  if (!sections.has('education')) gaps.push('No education recorded.');
  if (allSkills(profile).length === 0) gaps.push('No skills recorded.');
  for (const e of profile.entries) {
    const label = `${e.id} (${e.title}${e.organisation ? `, ${e.organisation}` : ''})`;
    if (!e.startDate && !e.endDate) gaps.push(`${label}: dates missing.`);
    if ((e.section === 'experience' || e.section === 'education') && !e.organisation)
      gaps.push(`${label}: ${e.section === 'education' ? 'institution' : 'employer'} missing.`);
    if ((e.section === 'experience' || e.section === 'project') && e.highlights.length === 0)
      gaps.push(`${label}: no achievements recorded — ask what they did and what changed because of it.`);
    else if (
      (e.section === 'experience' || e.section === 'project') &&
      e.highlights.length > 0 &&
      e.highlights.every((h) => extractNumbers(h).length === 0)
    )
      gaps.push(`${label}: no measurable outcomes — ask for numbers (scale, users, time saved, %, money, team size).`);
    if ((e.section === 'experience' || e.section === 'project') && e.skills.length === 0)
      gaps.push(`${label}: technologies/skills used are unknown.`);
  }
  return gaps;
}
