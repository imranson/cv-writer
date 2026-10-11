import { z } from 'zod';
import type { CheckFinding } from './checks.ts';

const score = z.coerce.number().min(0).max(10).describe('0 (very poor) to 10 (excellent)');
const list = <T extends z.ZodType>(item: T) => z.array(item).default([]);

/** What the critic model must submit. */
export const CritiqueInputSchema = z.object({
  summary: z.string().min(1).describe('Two or three sentences: overall assessment of the CV for this job.'),
  scores: z
    .object({
      relevance: score.describe('How well the CV targets the job requirements (0-10)'),
      impact: score.describe('Evidence of results: quantified achievements, strong action verbs, scope (0-10)'),
      clarity: score.describe('Concise, specific, easy to scan, no filler or clichés (0-10)'),
      structure: score.describe('Logical order, consistent formatting, ATS-friendly, appropriate length (0-10)'),
      accuracy: score.describe('Every claim is supported by the candidate profile; nothing invented or exaggerated (0-10)'),
    })
    .describe('Dimension scores, each 0-10'),
  coverage: list(
    z.object({
      requirement: z.string().describe('A requirement or desirable from the job listing'),
      status: z.enum(['met', 'partial', 'missing']),
      evidence: z.string().optional().describe('Where the CV demonstrates it, if anywhere'),
      suggestion: z.string().optional().describe('How to cover it better, using profile facts'),
    }),
  ).describe('Each key job requirement and how well the CV covers it'),
  mistakes: list(
    z.object({
      severity: z.enum(['critical', 'major', 'minor']),
      kind: z.enum(['spelling', 'grammar', 'formatting', 'consistency', 'content', 'other']),
      location: z.string().describe('Section / entry / bullet where the mistake is'),
      issue: z.string(),
      fix: z.string().describe('Concrete corrected text or action'),
    }),
  ).describe('Outright mistakes: typos, grammar, inconsistent dates/tense/format, broken structure'),
  factualIssues: list(
    z.object({
      claim: z.string().describe('The CV text in question'),
      problem: z.enum(['unsupported', 'contradicts_profile', 'exaggerated']),
      detail: z.string().describe('What the profile actually says, or what is missing'),
    }),
  ).describe('Claims not backed by, or contradicting, the candidate profile'),
  strengths: list(z.string()),
  improvements: list(z.string()).describe('Highest-impact improvements first'),
  questionsForCandidate: list(z.string()).describe('Information to ask the candidate for that would strengthen the CV'),
});

export type CritiqueInput = z.infer<typeof CritiqueInputSchema>;
export type Verdict = 'ready' | 'needs_work' | 'not_ready';

export interface Critique extends CritiqueInput {
  /** 0-100, computed from the dimension scores. */
  score: number;
  verdict: Verdict;
  /** Deterministic check findings at critique time. */
  checks: CheckFinding[];
  createdAt: string;
  /** Hash of the CV HTML that was critiqued, to detect staleness. */
  cvHash: string;
  focus?: string;
}

export const SCORE_WEIGHTS: Record<keyof CritiqueInput['scores'], number> = {
  relevance: 0.3,
  impact: 0.2,
  clarity: 0.15,
  structure: 0.15,
  accuracy: 0.2,
};

export function computeScore(scores: CritiqueInput['scores']): number {
  let total = 0;
  for (const [key, weight] of Object.entries(SCORE_WEIGHTS)) {
    total += scores[key as keyof typeof SCORE_WEIGHTS] * weight;
  }
  return Math.round(total * 10);
}

/**
 * A CV is only "ready" when it scores well AND has no blocking problems: critical/major mistakes,
 * claims that contradict the profile, or failing deterministic checks.
 */
export function computeVerdict(input: CritiqueInput, scoreValue: number, checks: CheckFinding[]): Verdict {
  const critical = input.mistakes.filter((m) => m.severity === 'critical').length;
  const major = input.mistakes.filter((m) => m.severity === 'major').length;
  const contradictions = input.factualIssues.filter((f) => f.problem === 'contradicts_profile').length;
  const unsupported = input.factualIssues.length - contradictions;
  const checkErrors = checks.filter((c) => c.severity === 'error').length;
  const missing = input.coverage.filter((c) => c.status === 'missing').length;

  if (scoreValue < 55 || critical > 0 || contradictions > 0) return 'not_ready';
  if (scoreValue >= 80 && major === 0 && unsupported === 0 && checkErrors === 0 && missing <= 1) return 'ready';
  return 'needs_work';
}

export function summariseCritique(c: Critique): string {
  const lines = [
    `Score: ${c.score}/100 — verdict: ${c.verdict.replace('_', ' ')}`,
    `Scores: ${Object.entries(c.scores)
      .map(([k, v]) => `${k} ${v}/10`)
      .join(', ')}`,
    `Summary: ${c.summary}`,
  ];
  const gaps = c.coverage.filter((x) => x.status !== 'met');
  if (gaps.length) lines.push(`Coverage gaps: ${gaps.map((g) => `${g.requirement} (${g.status})`).join('; ')}`);
  if (c.mistakes.length)
    lines.push(`Mistakes: ${c.mistakes.map((m) => `[${m.severity}] ${m.location}: ${m.issue} → ${m.fix}`).join(' | ')}`);
  if (c.factualIssues.length)
    lines.push(`Factual issues: ${c.factualIssues.map((f) => `"${f.claim}" — ${f.problem}: ${f.detail}`).join(' | ')}`);
  const checkProblems = c.checks.filter((x) => x.severity !== 'info');
  if (checkProblems.length) lines.push(`Automated checks: ${checkProblems.map((x) => `[${x.severity}] ${x.message}`).join(' | ')}`);
  if (c.improvements.length) lines.push(`Top improvements: ${c.improvements.slice(0, 5).join(' | ')}`);
  if (c.questionsForCandidate.length) lines.push(`Questions for the candidate: ${c.questionsForCandidate.join(' | ')}`);
  return lines.join('\n');
}
