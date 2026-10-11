import { describe, expect, it } from 'vitest';
import { evaluateMath } from '../../src/lib/math.js';

describe('evaluateMath', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 ^ 3 ^ 2', 512],
    ['-2 ^ 2', -4],
    ['10 % 4', 2],
    ['(2026 - 2019) + 4/12', 7 + 4 / 12],
    ['sqrt(16) + abs(-3)', 7],
    ['round(2/3, 2)', 0.67],
    ['max(1, 5, 3) - min(4, 2)', 3],
    ['log(1000)', 3],
    ['log(8, 2)', 3],
    ['ln(e)', 1],
    ['2 * pi', 2 * Math.PI],
    ['1.5e3 / 3', 500],
    ['+-+4', -4],
  ])('%s = %d', (expr, expected) => {
    expect(evaluateMath(expr)).toBeCloseTo(expected, 10);
  });

  it.each([
    ['', 'Empty expression'],
    ['1 +', 'Unexpected end'],
    ['(1 + 2', 'Expected ")"'],
    ['1 / 0', 'Division by zero'],
    ['foo(1)', 'Unknown function'],
    ['x + 1', 'Unknown identifier'],
    ['1 $ 2', 'Unexpected character'],
    ['1 2', 'Unexpected token'],
    ['sqrt(-1)', 'not a finite number'],
  ])('rejects %j', (expr, message) => {
    expect(() => evaluateMath(expr)).toThrow(message);
  });

  it('cannot reach JavaScript globals', () => {
    expect(() => evaluateMath('constructor')).toThrow('Unknown identifier');
    expect(() => evaluateMath('process.exit(1)')).toThrow();
  });
});

describe('evaluateMath prototype safety', () => {
  it('does not treat Object.prototype members as functions', () => {
    expect(() => evaluateMath('constructor(1)')).toThrow('Unknown function');
    expect(() => evaluateMath('toString(1)')).toThrow('Unknown function');
  });
});
