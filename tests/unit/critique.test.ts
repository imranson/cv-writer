import { describe, expect, it } from 'vitest';
import type { CheckFinding } from '../../src/cv/checks.ts';
import { computeScore, computeVerdict, CritiqueInputSchema, summariseCritique, type Critique } from '../../src/cv/critique.ts';
import { critiqueInput } from '../support/fixtures.ts';

const err: CheckFinding = { id: 'placeholder', severity: 'error', message: 'Placeholder' };

describe('critique scoring', () => {
  it('computes a weighted 0-100 score', () => {
    expect(computeScore({ relevance: 10, impact: 10, clarity: 10, structure: 10, accuracy: 10 })).toBe(100);
    expect(computeScore({ relevance: 5, impact: 5, clarity: 5, structure: 5, accuracy: 5 })).toBe(50);
    expect(computeScore({ relevance: 10, impact: 0, clarity: 0, structure: 0, accuracy: 0 })).toBe(30);
  });

  it('only calls a CV ready when it scores well and has no blocking problems', () => {
    const good = critiqueInput();
    const score = computeScore(good.scores);
    expect(score).toBeGreaterThanOrEqual(80);
    expect(computeVerdict(good, score, [])).toBe('ready');
    expect(computeVerdict(good, score, [err])).toBe('needs_work');
    expect(computeVerdict({ ...good, mistakes: [{ severity: 'major', kind: 'grammar', location: 'x', issue: 'y', fix: 'z' }] }, score, [])).toBe('needs_work');
    expect(computeVerdict({ ...good, factualIssues: [{ claim: 'c', problem: 'unsupported', detail: 'd' }] }, score, [])).toBe('needs_work');
    expect(
      computeVerdict({ ...good, coverage: [...good.coverage, { requirement: 'a', status: 'missing' }, { requirement: 'b', status: 'missing' }] }, score, []),
    ).toBe('needs_work');
  });

  it('marks CVs with critical mistakes, contradictions or low scores as not ready', () => {
    const good = critiqueInput();
    expect(computeVerdict(good, 54, [])).toBe('not_ready');
    expect(computeVerdict({ ...good, mistakes: [{ severity: 'critical', kind: 'content', location: 'x', issue: 'y', fix: 'z' }] }, 90, [])).toBe('not_ready');
    expect(computeVerdict({ ...good, factualIssues: [{ claim: 'c', problem: 'contradicts_profile', detail: 'd' }] }, 90, [])).toBe('not_ready');
  });
});

describe('CritiqueInputSchema', () => {
  it('coerces numeric strings and defaults missing lists', () => {
    const parsed = CritiqueInputSchema.parse({ summary: 'ok', scores: { relevance: '7', impact: 6, clarity: 6, structure: 6, accuracy: 6 } });
    expect(parsed.scores.relevance).toBe(7);
    expect(parsed.mistakes).toEqual([]);
    expect(parsed.questionsForCandidate).toEqual([]);
  });

  it('rejects out-of-range scores and unknown enum values', () => {
    expect(CritiqueInputSchema.safeParse({ summary: 's', scores: { relevance: 11, impact: 1, clarity: 1, structure: 1, accuracy: 1 } }).success).toBe(false);
    expect(
      CritiqueInputSchema.safeParse({ ...critiqueInput(), coverage: [{ requirement: 'x', status: 'sort of' }] }).success,
    ).toBe(false);
  });
});

describe('summariseCritique', () => {
  it('produces a compact text summary for agents', () => {
    const input = critiqueInput({
      coverage: [{ requirement: 'SQL', status: 'partial' }],
      mistakes: [{ severity: 'minor', kind: 'spelling', location: 'Summary', issue: 'teh', fix: 'the' }],
      factualIssues: [{ claim: '50% growth', problem: 'unsupported', detail: 'not in profile' }],
    });
    const c: Critique = { ...input, score: 81, verdict: 'needs_work', checks: [err], createdAt: '', cvHash: 'x' };
    const text = summariseCritique(c);
    expect(text).toContain('Score: 81/100 — verdict: needs work');
    expect(text).toContain('Coverage gaps: SQL (partial)');
    expect(text).toContain('[minor] Summary: teh → the');
    expect(text).toContain('"50% growth" — unsupported');
    expect(text).toContain('[error] Placeholder');
    expect(text).toContain('Questions for the candidate');
  });
});
