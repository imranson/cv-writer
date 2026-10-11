import { describe, expect, it } from 'vitest';
import { extractBullets, hasBlockingFindings, preferredMaxPages, runChecks } from '../../src/cv/checks.ts';
import { CV_HTML, PROFILE } from '../support/fixtures.ts';

const ids = (html: string, profile = PROFILE, extra: { pageCount?: number; maxPages?: number } = {}) =>
  runChecks(html, { profile, ...extra }).map((f) => `${f.severity}:${f.id}`);

describe('runChecks', () => {
  it('passes a clean CV whose facts all come from the profile', () => {
    const findings = runChecks(CV_HTML, { profile: PROFILE });
    expect(findings.filter((f) => f.severity !== 'info')).toEqual([
      // the fixture CV is intentionally short
      expect.objectContaining({ id: 'too-short' }),
    ]);
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it('flags an empty CV', () => {
    expect(ids('')).toEqual(['error:empty']);
  });

  it('requires a name heading and contact details', () => {
    const r = ids('<section><h2>Experience</h2><p>Text</p></section>');
    expect(r).toContain('error:missing-name');
    expect(r).toContain('error:missing-contact');
    expect(ids('<header><h1>A</h1><p>+44 7700 900456</p></header>')).toContain('warning:missing-email');
  });

  it('flags placeholders and template leftovers', () => {
    const f = runChecks(CV_HTML.replace('Bristol, UK', '[City]').replace('Product manager with', 'TODO Product manager with'), { profile: PROFILE });
    const placeholder = f.find((x) => x.id === 'placeholder');
    expect(placeholder?.severity).toBe('error');
    expect(placeholder?.message).toMatch(/\[City\]/);
    expect(placeholder?.message).toMatch(/TODO/);
  });

  it('warns about numbers that are not in the profile (possible invented metrics)', () => {
    const f = runChecks(CV_HTML.replace('by 18%', 'by 35%').replace('40,000', '40,000'), { profile: PROFILE });
    const n = f.find((x) => x.id === 'unverified-number');
    expect(n?.message).toContain('35%');
    expect(n?.message).not.toContain('40,000');
  });

  it('treats invented contact details as errors', () => {
    const f = runChecks(CV_HTML.replace('alex.morgan@example.com', 'alex@fake.io'), { profile: PROFILE });
    expect(f.find((x) => x.id === 'unverified-contact')?.severity).toBe('error');
    // a LinkedIn URL from the profile is fine with or without scheme/www
    const ok = runChecks(CV_HTML.replace('<li>Bristol, UK</li>', '<li>https://www.linkedin.com/in/alexmorgan</li>'), { profile: PROFILE });
    expect(ok.find((x) => x.id === 'unverified-contact')).toBeUndefined();
  });

  it('finds duplicate, overlong and first-person bullets and repeated words', () => {
    const long = `<li>${'word '.repeat(50)}</li>`;
    const html = CV_HTML.replace(
      '<li>Automated 3 manual claims reports, saving 10 hours per week.</li>',
      `<li>Automated 3 manual claims reports, saving 10 hours per week.</li><li>Automated 3 manual claims reports, saving 10 hours per week.</li>${long}<li>I managed my team well</li><li>Worked with the the team</li>`,
    );
    const r = ids(html);
    expect(r).toEqual(expect.arrayContaining(['warning:duplicate-bullet', 'warning:long-bullet', 'warning:first-person', 'warning:repeated-word']));
  });

  it('warns about missing experience headings and mixed date formats', () => {
    expect(ids(CV_HTML.replace('<h2>Experience</h2>', '<h2>History</h2>'))).toContain('warning:no-experience');
    expect(ids(CV_HTML.replace('Sep 2017 – Dec 2020', '09/2017 – 12/2020'))).toContain('warning:date-format');
  });

  it('checks the page count against the limit from the profile preferences', () => {
    expect(ids(CV_HTML, PROFILE, { pageCount: 3 })).toContain('error:page-count');
    expect(ids(CV_HTML, PROFILE, { pageCount: 2 })).toContain('info:page-count');
    expect(ids(CV_HTML, PROFILE.replace('Maximum 2 pages', 'One-page CV please'), { pageCount: 2 })).toContain('error:page-count');
  });

  it('flags unsafe markup if it ever reaches the checks', () => {
    expect(ids(`${CV_HTML}<script>x</script>`)).toContain('error:unsafe-markup');
  });
});

describe('helpers', () => {
  it('reads the preferred page limit', () => {
    expect(preferredMaxPages('max 1 page')).toBe(1);
    expect(preferredMaxPages('a two-page CV')).toBe(2);
    expect(preferredMaxPages('nothing')).toBe(2);
    expect(preferredMaxPages('9 pages')).toBe(2);
  });

  it('extracts bullet text', () => {
    expect(extractBullets('<ul><li>One <b>two</b></li><li></li><li>Three</li></ul>')).toEqual(['One two', 'Three']);
  });
});
