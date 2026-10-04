import { describe, expect, it } from 'vitest';
import {
  addFacts,
  addHighlights,
  emptyProfile,
  mergeContact,
  mergeSkills,
  mergeUnique,
  profileCompleteness,
  profileCorpus,
  removeEntry,
  upsertEntry,
} from '../../src/domain/profile.js';
import { sampleProfile } from '../helpers.js';

const genId = (section: string) => `${section}-new`;

describe('mergeUnique', () => {
  it('appends new items, ignoring case/whitespace duplicates and blanks', () => {
    expect(mergeUnique(['Python', 'SQL'], [' python ', 'Go', '', 'go', 'Rust'])).toEqual(['Python', 'SQL', 'Go', 'Rust']);
  });
});

describe('mergeContact', () => {
  it('changes only the fields given and accumulates links', () => {
    const p = mergeContact(sampleProfile(), { phone: '+44 1', links: ['linkedin.com/in/alex', 'github.com/alexmorgan'] });
    expect(p.contact).toMatchObject({ name: 'Alex Morgan', phone: '+44 1' });
    expect(p.contact.links).toEqual(['github.com/alexmorgan', 'linkedin.com/in/alex']);
  });

  it('ignores explicitly undefined fields', () => {
    const p = mergeContact(sampleProfile(), { name: undefined });
    expect(p.contact.name).toBe('Alex Morgan');
  });
});

describe('upsertEntry', () => {
  it('creates an entry with a generated id and default arrays', () => {
    const { profile, entry, created } = upsertEntry(emptyProfile(), { section: 'experience', title: ' Intern ' }, genId);
    expect(created).toBe(true);
    expect(entry).toEqual({ id: 'experience-new', section: 'experience', title: 'Intern', highlights: [], skills: [] });
    expect(profile.entries).toHaveLength(1);
  });

  it('updates only the given fields of an existing entry', () => {
    const { entry, created, profile } = upsertEntry(sampleProfile(), { id: 'experience-1', endDate: 'Sept 2025' }, genId);
    expect(created).toBe(false);
    expect(entry.endDate).toBe('Sept 2025');
    expect(entry.highlights).toHaveLength(2);
    expect(profile.entries).toHaveLength(3);
  });

  it('requires section and title when creating', () => {
    expect(() => upsertEntry(emptyProfile(), { title: 'X' }, genId)).toThrow(/section is required/);
    expect(() => upsertEntry(emptyProfile(), { section: 'award', title: '  ' }, genId)).toThrow(/title is required/);
  });

  it('creates an entry under a caller-supplied id that does not exist yet', () => {
    const { entry, created } = upsertEntry(emptyProfile(), { id: 'custom', section: 'award', title: 'Prize' }, genId);
    expect(created).toBe(true);
    expect(entry.id).toBe('custom');
  });

  it('does not mutate the input profile', () => {
    const original = sampleProfile();
    upsertEntry(original, { id: 'experience-1', title: 'Changed' }, genId);
    expect(original.entries[1]!.title).toBe('Research Intern');
  });
});

describe('addHighlights / removeEntry', () => {
  it('appends highlights without duplicates', () => {
    const p = addHighlights(sampleProfile(), 'project-1', ['New win', 'new win']);
    expect(p.entries.find((e) => e.id === 'project-1')!.highlights).toHaveLength(2);
  });

  it('rejects unknown ids', () => {
    expect(() => addHighlights(sampleProfile(), 'nope', ['x'])).toThrow(/No profile entry/);
    expect(() => removeEntry(sampleProfile(), 'nope')).toThrow(/No profile entry/);
  });

  it('removes an entry', () => {
    expect(removeEntry(sampleProfile(), 'project-1').entries.map((e) => e.id)).toEqual(['education-1', 'experience-1']);
  });
});

describe('mergeSkills / addFacts', () => {
  it('merges into an existing category case-insensitively', () => {
    const p = mergeSkills(sampleProfile(), 'languages', ['Go', 'python']);
    expect(p.skills[0]).toEqual({ category: 'Languages', items: ['Python', 'TypeScript', 'SQL', 'Go'] });
  });

  it('creates a new category', () => {
    const p = mergeSkills(sampleProfile(), ' Tools ', ['Git', 'git']);
    expect(p.skills.at(-1)).toEqual({ category: 'Tools', items: ['Git'] });
  });

  it('de-duplicates facts', () => {
    expect(addFacts(sampleProfile(), ['uk english spelling', 'Available from July']).facts).toHaveLength(3);
  });
});

describe('profileCompleteness', () => {
  it('lists everything missing from an empty profile', () => {
    const { complete, missing } = profileCompleteness(emptyProfile());
    expect(complete).toBe(false);
    expect(missing).toEqual([
      'full name',
      'email address',
      'phone number',
      'location (city, country)',
      'career goal / target role',
      'education',
      'work experience or projects',
      'skills',
    ]);
  });

  it('is complete for a full profile', () => {
    expect(profileCompleteness(sampleProfile())).toEqual({ complete: true, missing: [] });
  });

  it('flags experience and projects without achievements', () => {
    const p = upsertEntry(sampleProfile(), { section: 'project', title: 'Side project' }, genId).profile;
    expect(profileCompleteness(p).missing).toEqual(['achievements for "Side project" (project-new)']);
  });
});

describe('profileCorpus', () => {
  it('includes contact, entries, skills and facts', () => {
    const corpus = profileCorpus(sampleProfile());
    for (const text of ['alex.morgan@example.com', '122,000+', 'Supabase', 'AWS Lambda', 'right to work']) {
      expect(corpus).toContain(text);
    }
  });
});
