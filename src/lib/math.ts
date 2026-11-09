/**
 * Safe arithmetic evaluator (no `eval`). Supports + - * / % ^ (or **), parentheses, unary minus,
 * scientific notation, constants (pi, e, tau) and common functions.
 */

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  sign: Math.sign,
  exp: Math.exp,
  ln: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  log: (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)),
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  pow: Math.pow,
  hypot: Math.hypot,
  min: Math.min,
  max: Math.max,
  sum: (...xs) => xs.reduce((a, b) => a + b, 0),
  avg: (...xs) => xs.reduce((a, b) => a + b, 0) / xs.length,
  mean: (...xs) => xs.reduce((a, b) => a + b, 0) / xs.length,
  round: (x, digits = 0) => {
    const f = 10 ** digits;
    return Math.round(x * f) / f;
  },
};

type Token = { type: 'num'; value: number } | { type: 'id'; value: string } | { type: 'op'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      tokens.push({ type: 'num', value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i));
    if (id) {
      tokens.push({ type: 'id', value: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    if (src.startsWith('**', i)) {
      tokens.push({ type: 'op', value: '^' });
      i += 2;
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" at position ${i}`);
  }
  return tokens;
}

export function evaluate(expression: string): number {
  if (expression.length > 1000) throw new Error('Expression too long');
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.type === 'op' && peek()!.value === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`);
    pos++;
  };

  const parseExpr = (): number => {
    let left = parseTerm();
    while (isOp('+') || isOp('-')) {
      const op = tokens[pos++].value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  const parseTerm = (): number => {
    let left = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[pos++].value;
      const right = parseUnary();
      if (op === '*') left *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        left /= right;
      } else left %= right;
    }
    return left;
  };
  const parseUnary = (): number => {
    if (isOp('-')) {
      pos++;
      return -parseUnary();
    }
    if (isOp('+')) {
      pos++;
      return parseUnary();
    }
    return parsePower();
  };
  const parsePower = (): number => {
    const base = parsePrimary();
    if (isOp('^')) {
      pos++;
      return base ** parseUnary(); // right-associative
    }
    return base;
  };
  const parsePrimary = (): number => {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of expression');
    if (tok.type === 'num') {
      pos++;
      return tok.value;
    }
    if (tok.type === 'id') {
      pos++;
      if (isOp('(')) {
        const fn = FUNCTIONS[tok.value];
        if (!fn) throw new Error(`Unknown function "${tok.value}"`);
        pos++;
        const args: number[] = [];
        if (!isOp(')')) {
          args.push(parseExpr());
          while (isOp(',')) {
            pos++;
            args.push(parseExpr());
          }
        }
        expect(')');
        return fn(...args);
      }
      if (tok.value in CONSTANTS) return CONSTANTS[tok.value];
      throw new Error(`Unknown identifier "${tok.value}"`);
    }
    if (tok.value === '(') {
      pos++;
      const v = parseExpr();
      expect(')');
      return v;
    }
    throw new Error(`Unexpected "${tok.value}"`);
  };

  const result = parseExpr();
  if (pos < tokens.length) throw new Error(`Unexpected "${String(tokens[pos].value)}"`);
  if (Number.isNaN(result)) throw new Error('Result is not a number');
  return result;
}
