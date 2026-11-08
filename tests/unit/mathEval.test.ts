import { describe, expect, it } from 'vitest';
import { evaluateMath, tokenize } from '../../src/lib/mathEval.js';

describe('evaluateMath (evalMath tool core)', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 ^ 3 ^ 2', 512],
    ['2 ** 10', 1024],
    ['-2 ^ 2', -4],
    ['10 % 4', 2],
    ['1_000_000 / 4', 250000],
    ['.5 + 1.5e2', 150.5],
    ['round(37/52*100, 1)', 71.2],
    ['max(3, 9, 4) - min(3, 9, 4)', 6],
    ['sum(1,2,3,4)', 10],
    ['avg(2, 4, 6)', 4],
    ['sqrt(16) + abs(-3)', 7],
    ['round(pi, 3)', 3.142],
    ['(2026 - 2019) * 12 + 4', 88],
    ['log(1000)', 3],
  ])('%s = %d', (expr, expected) => {
    expect(evaluateMath(expr)).toBeCloseTo(expected, 10);
  });

  it.each([
    ['', 'Empty expression'],
    ['1 / 0', 'Division by zero'],
    ['2 +', 'Unexpected end'],
    ['(1 + 2', 'Expected ")"'],
    ['foo(1)', 'Unknown function'],
    ['x + 1', 'Unknown identifier'],
    ['process.exit()', 'Unexpected character'],
    ['1 2', 'Unexpected token'],
    ['sqrt(-1)', 'not a finite number'],
  ])('rejects %j', (expr, message) => {
    expect(() => evaluateMath(expr)).toThrow(message);
  });

  it('never evaluates JavaScript', () => {
    expect(() => evaluateMath('constructor.constructor("return 1")()')).toThrow();
    expect(tokenize('a1 + 2')).toEqual([
      { kind: 'id', value: 'a1' },
      { kind: 'op', value: '+' },
      { kind: 'num', value: 2 },
    ]);
  });
});
