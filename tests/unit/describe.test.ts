import { describe, expect, it } from 'vitest';
import { describeToolUse } from '../../src/app/describe.js';

describe('describeToolUse', () => {
  it('describes app tools by their MCP name', () => {
    expect(describeToolUse('mcp__cv__get_profile', {})).toBe('Reading your profile');
    expect(describeToolUse('mcp__cv__upsert_profile_entry', { section: 'experience', title: 'Intern' })).toBe(
      'Adding "Intern" to your profile',
    );
    expect(describeToolUse('mcp__cv__upsert_profile_entry', { id: 'exp-1' })).toBe('Updating "exp-1" in your profile');
    expect(describeToolUse('mcp__cv__save_job_listing', { title: 'SWE', company: 'Acme' })).toBe('Saving the SWE listing at Acme');
    expect(describeToolUse('mcp__cv__get_cv_version', { version: 2 })).toBe('Opening CV version 2');
    expect(describeToolUse('mcp__cv__approve_cv', { version: 3 })).toBe('Approving version 3 and exporting files');
  });

  it('describes built-in tools and tolerates missing input', () => {
    expect(describeToolUse('Agent', undefined)).toMatch(/Handing over to the CV writer/);
    expect(describeToolUse('WebFetch', { url: 'https://jobs.example/1' })).toBe('Fetching https://jobs.example/1');
    expect(describeToolUse('mcp__cv__add_skills', null)).toBe('Saving your skills');
  });

  it('prefixes subagent activity and skips unknown tools', () => {
    expect(describeToolUse('mcp__cv__save_cv_version', {}, true)).toBe('cv-writer: Saving a CV draft and running checks');
    expect(describeToolUse('Bash', { command: 'ls' })).toBeUndefined();
    expect(describeToolUse('mcp__other__get_profile', {})).toBeUndefined();
  });
});
