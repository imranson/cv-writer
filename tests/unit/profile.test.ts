import { describe, expect, it } from 'vitest';
import * as P from '../../src/domain/profile.js';
import { PROFILE } from '../support/fixtures.js';

describe('profile operations', () => {
  it('updates contact fields without touching others, and clears empty ones', () => {
    const next = P.updateContact(PROFILE, { phone: ' +44 1 ', location: '' });
    expect(next.contact).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com', phone: '+44 1' });
    expect(next.contact.location).toBeUndefined();
    expect(PROFILE.contact.location).toBe('London, UK'); // immutability
  });

  it('dedupes links case-insensitively', () => {
    expect(P.updateContact(PROFILE, { links: ['a.com', 'A.com', ' b.com '] }).contact.links).toEqual(['a.com', 'b.com']);
  });

  it('adds an entry with a section-prefixed id and deduped highlights', () => {
    const { profile, entry } = P.addEntry(PROFILE, { section: 'project', title: 'CLI tool', highlights: ['x', 'X', 'y'] });
    expect(entry.id).toMatch(/^project-[0-9a-f]{6}$/);
    expect(entry.highlights).toEqual(['x', 'y']);
    expect(profile.entries).toHaveLength(3);
  });

  it('updates an entry: append, remove by text and position, replace skills', () => {
    const { entry } = P.updateEntry(PROFILE, 'experience-aaa111', {
      addHighlights: ['Mentored 2 juniors'],
      removeHighlights: [1],
      addSkills: ['Docker', 'python'],
      endDate: 'Aug 2026',
    });
    expect(entry.highlights).toEqual(['Cut deployment time from 45 to 8 minutes with GitHub Actions', 'Mentored 2 juniors']);
    expect(entry.skills).toEqual(['Python', 'PostgreSQL', 'AWS', 'GitHub Actions', 'Docker']);
    expect(entry.endDate).toBe('Aug 2026');
    const { entry: e2 } = P.updateEntry(PROFILE, 'experience-aaa111', { removeHighlights: ['built a python payments api serving 40,000 requests per minute'] });
    expect(e2.highlights).toHaveLength(1);
  });

  it('rejects unknown ids, missing highlights and empty titles with helpful errors', () => {
    expect(() => P.updateEntry(PROFILE, 'nope', {})).toThrow(/Known ids: experience-aaa111, education-bbb222/);
    expect(() => P.updateEntry(PROFILE, 'experience-aaa111', { removeHighlights: [9] })).toThrow(P.ProfileError);
    expect(() => P.updateEntry(PROFILE, 'experience-aaa111', { title: ' ' })).toThrow(/title cannot be empty/);
    expect(() => P.removeEntry(PROFILE, 'nope')).toThrow(P.ProfileError);
  });

  it('merges skills into existing categories and removes them everywhere', () => {
    const added = P.addSkills(PROFILE, 'languages', ['Go', 'python']);
    expect(added.skills).toEqual([{ category: 'Languages', items: ['Python', 'TypeScript', 'SQL', 'Go'] }]);
    const newCat = P.addSkills(PROFILE, 'Spoken', ['French']);
    expect(newCat.skills.map((g) => g.category)).toEqual(['Languages', 'Spoken']);
    expect(P.removeSkills(newCat, ['french', 'SQL']).skills).toEqual([{ category: 'Languages', items: ['Python', 'TypeScript'] }]);
  });

  it('adds and removes facts', () => {
    const p = P.addFacts(PROFILE, ['Notice period: 1 month', 'right to work in the UK']);
    expect(p.facts).toEqual(['Right to work in the UK', 'Notice period: 1 month']);
    expect(P.removeFacts(p, [1]).facts).toEqual(['Notice period: 1 month']);
    expect(() => P.removeFacts(p, ['missing'])).toThrow(P.ProfileError);
  });

  it('collects all skills and all profile text', () => {
    expect(P.allSkills(PROFILE)).toContain('GitHub Actions');
    const text = P.profileText(PROFILE);
    expect(text).toContain('40,000');
    expect(text).toContain('Right to work in the UK');
  });
});

describe('profileGaps', () => {
  it('lists everything missing from an empty profile', () => {
    const gaps = P.profileGaps(P.emptyProfile());
    expect(gaps.join('\n')).toMatch(/Full name/);
    expect(gaps.join('\n')).toMatch(/No work experience/);
    expect(gaps.join('\n')).toMatch(/Career goal/);
  });

  it('asks for achievements, numbers and skills on thin entries', () => {
    const { profile } = P.addEntry(PROFILE, { section: 'experience', title: 'Intern', organisation: 'Acme' });
    const withVague = P.addEntry(profile, { section: 'project', title: 'Site', highlights: ['Made a website'], skills: ['HTML'], startDate: '2020' }).profile;
    const gaps = P.profileGaps(withVague).join('\n');
    expect(gaps).toMatch(/Intern, Acme\): dates missing/);
    expect(gaps).toMatch(/Intern, Acme\): no achievements recorded/);
    expect(gaps).toMatch(/Site\): no measurable outcomes/);
    expect(gaps).toMatch(/Intern, Acme\): technologies\/skills used are unknown/);
    const noSchool = P.addEntry(PROFILE, { section: 'education', title: 'BA History', startDate: '2019' }).profile;
    expect(P.profileGaps(noSchool).join('\n')).toMatch(/BA History\): institution missing/);
  });

  it('is quiet for a complete profile', () => {
    expect(P.profileGaps(PROFILE)).toEqual([]);
  });
});
