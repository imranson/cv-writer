import { describe, expect, it } from 'vitest';
import { describeToolCall, describeToolResult } from '../../src/app/describe.js';

describe('describeToolCall', () => {
  it('labels coordinator tools for the user', () => {
    expect(describeToolCall('upsert_profile_entry', { title: 'Intern' })).toBe('Adding "Intern" to your profile');
    expect(describeToolCall('upsert_profile_entry', { id: 'experience-1' })).toBe('Updating "experience-1" in your profile');
    expect(describeToolCall('save_job_listing', { title: 'Engineer', company: 'Acme' })).toBe('Saving the Engineer listing at Acme');
    expect(describeToolCall('write_cv', { jobId: 'j' })).toBe('Handing over to the CV writer, this can take a minute or two');
    expect(describeToolCall('write_cv', { jobId: 'j', basedOnVersion: 2 })).toMatch(/^Handing your feedback on version 2/);
    expect(describeToolCall('show_cv', { version: 3 })).toBe('Opening CV version 3');
    expect(describeToolCall('approve_cv', { version: 3 })).toBe('Approving version 3 and exporting files');
    expect(describeToolCall('fetch_job_posting', { url: 'https://x' })).toBe('Fetching https://x');
  });

  it('prefixes writer activity and skips unknown tools', () => {
    expect(describeToolCall('save_cv_version', {}, 'cv-writer')).toBe('cv-writer: Saving a draft and running checks');
    expect(describeToolCall('mystery', {})).toBeUndefined();
  });
});

describe('describeToolResult', () => {
  const result = (output: unknown, ok = true, name = 'save_cv_version') =>
    describeToolResult({ type: 'tool-result', agent: 'cv-writer', name, ok, output: typeof output === 'string' ? output : JSON.stringify(output) });

  it('summarises the checks on each saved draft', () => {
    expect(result({ version: 1, verificationPassed: false, issues: [{ severity: 'error' }, { severity: 'error' }, { severity: 'warning' }] })).toBe(
      'cv-writer: saved version 1 (2 errors to fix)',
    );
    expect(result({ version: 2, verificationPassed: true, issues: [] })).toBe('cv-writer: saved version 2 (checks passed)');
    expect(result({ version: 3, verificationPassed: true, issues: [{ severity: 'warning' }, { severity: 'warning' }] })).toBe(
      'cv-writer: saved version 3 (checks passed with 2 warnings)',
    );
  });

  it('ignores failures, other tools and unparseable output', () => {
    expect(result({ version: 1 }, false)).toBeUndefined();
    expect(result({ version: 1 }, true, 'add_facts')).toBeUndefined();
    expect(result('not json')).toBeUndefined();
  });
});
