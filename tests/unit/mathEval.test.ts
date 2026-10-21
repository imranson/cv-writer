import { describe, expect, it } from 'vitest';
import { evaluateMath } from '../../src/util/mathEval';

describe('evaluateMath', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 ^ 3 ^ 2', 512],
    ['2 ** 10', 1024],
    ['-2 ^ 2', -4],
    ['10 % 4', 2],
    ['-(3 - 5)', 2],
    ['1.5e2 + .5', 150.5],
    ['sqrt(16) + abs(-3)', 7],
    ['round(2 / 3, 2)', 0.67],
    ['max(1, 9, 4) - min(3, 2)', 7],
    ['sum(1, 2, 3) / avg(2, 4)', 2],
    ['log(1000)', 3],
    ['log(8, 2)', 3],
    ['floor(pi * 100)', 314],
    ['(2026 - 2019) * 12 + 4', 88],
  ])('%s = %d', (expr, expected) => {
    expect(evaluateMath(expr)).toBeCloseTo(expected, 10);
  });

  it.each([
    ['1 / 0', /Division by zero/],
    ['2 +', /end of expression/],
    ['(1 + 2', /Expected "\)"/],
    ['foo(1)', /Unknown function/],
    ['bar', /Unknown identifier/],
    ['1; process.exit()', /Unexpected character/],
    ['1 2', /Unexpected "2"/],
    ['sqrt(-1)', /not a finite number/],
  ])('rejects %s', (expr, error) => {
    expect(() => evaluateMath(expr)).toThrow(error);
  });

  it('refuses very long input', () => {
    expect(() => evaluateMath('1+'.repeat(600) + '1')).toThrow(/too long/);
  });
});
