import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/lib/math.js';

describe('evaluate (safe math)', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 ^ 3 ^ 2', 512],
    ['2 ** 10', 1024],
    ['-2 ^ 2', -4],
    ['10 % 4', 2],
    ['1e3 / 4', 250],
    ['.5 + .25', 0.75],
    ['sqrt(16) + abs(-3)', 7],
    ['round(2/3, 2)', 0.67],
    ['max(3, 9, 4) - min(3, 9, 4)', 6],
    ['sum(1,2,3,4)', 10],
    ['avg(2, 4)', 3],
    ['log(1000)', 3],
    ['log(8, 2)', 3],
    ['ln(e)', 1],
    ['round(pi, 4)', 3.1416],
    ['round((2026 - 2019) + 7/12, 1)', 7.6],
  ])('%s = %d', (expr, expected) => {
    expect(evaluate(expr)).toBeCloseTo(expected as number, 10);
  });

  it.each([
    ['1 / 0', /Division by zero/],
    ['2 +', /Unexpected end/],
    ['foo(1)', /Unknown function/],
    ['bar', /Unknown identifier/],
    ['1 2', /Unexpected/],
    ['process.exit()', /Unexpected character|Unknown/],
    ['(1 + 2', /Expected "\)"/],
    ['sqrt(-1)', /not a number/],
  ])('rejects %s', (expr, err) => {
    expect(() => evaluate(expr)).toThrow(err);
  });

  it('rejects very long input', () => {
    expect(() => evaluate('1+'.repeat(600) + '1')).toThrow(/too long/);
  });
});
