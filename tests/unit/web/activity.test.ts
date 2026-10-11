import { describe, expect, it } from 'vitest';
import { agentLabel, resultHighlight, toolIcon, toolLabel } from '../../../web/src/activity.ts';

describe('activity labels', () => {
  it('labels tools in progress and when done, with useful arguments', () => {
    expect(toolLabel('write_cv')).toBe('CV Writer is working');
    expect(toolLabel('write_cv', {}, true)).toBe('CV Writer finished');
    expect(toolLabel('save_job', { title: 'PM', company: 'Co' }, true)).toBe('Saved job listing: PM — Co');
    expect(toolLabel('read_skill', { id: 'ats' })).toBe('Reading skill: ats');
    expect(toolLabel('mystery_tool')).toBe('mystery tool');
    expect(toolIcon('critique_cv')).toBe('🔎');
    expect(toolIcon('unknown')).toBe('🔧');
    expect(agentLabel('critic')).toBe('Critic');
  });

  it('highlights key results', () => {
    expect(resultHighlight('critique_cv', 'Score: 78/100 — verdict: needs work\n...')).toBe('78/100 · needs work');
    expect(resultHighlight('write_cv', 'CV saved (412 words).')).toBe('412 words');
    expect(resultHighlight('export_pdf', 'PDF rendered: 1 page(s).')).toBe('1 page');
    expect(resultHighlight('read_cv', 'x')).toBeNull();
  });
});
