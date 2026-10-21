// Safe arithmetic evaluator (recursive descent, no `eval`).
// Supports + - * / % ^, parentheses, unary minus, constants and common functions.

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  round: (x, digits = 0) => {
    const f = 10 ** digits;
    return Math.round(x * f) / f;
  },
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  min: Math.min,
  max: Math.max,
  log: (x, base?: number) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)),
  ln: Math.log,
  log2: Math.log2,
  exp: Math.exp,
  pow: Math.pow,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  avg: (...xs) => xs.reduce((a, b) => a + b, 0) / xs.length,
  sum: (...xs) => xs.reduce((a, b) => a + b, 0),
};

type Token = { type: 'num'; value: number } | { type: 'id'; value: string } | { type: 'op'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new Error(`Invalid number at position ${i}`);
      tokens.push({ type: 'num', value: Number(m[0]) });
      i += m[0].length;
    } else if (/[a-z_]/i.test(ch)) {
      const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i))!;
      tokens.push({ type: 'id', value: m[0].toLowerCase() });
      i += m[0].length;
    } else if ('+-*/%^(),'.includes(ch)) {
      // Treat ** as ^
      if (ch === '*' && src[i + 1] === '*') {
        tokens.push({ type: 'op', value: '^' });
        i += 2;
      } else {
        tokens.push({ type: 'op', value: ch });
        i++;
      }
    } else {
      throw new Error(`Unexpected character "${ch}" at position ${i}`);
    }
  }
  return tokens;
}

export function evaluateMath(expression: string): number {
  if (expression.length > 1000) throw new Error('Expression too long');
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.type === 'op' && peek()!.value === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`);
    pos++;
  };

  // expr := term (('+'|'-') term)*
  const expr = (): number => {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = tokens[pos++].value;
      const right = term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  // term := unary (('*'|'/'|'%') unary)*
  const term = (): number => {
    let left = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[pos++].value;
      const right = unary();
      if (op === '*') left *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        left /= right;
      } else left %= right;
    }
    return left;
  };
  // unary := ('-'|'+') unary | power
  const unary = (): number => {
    if (isOp('-')) {
      pos++;
      return -unary();
    }
    if (isOp('+')) {
      pos++;
      return unary();
    }
    return power();
  };
  // power := primary ('^' unary)?   (right associative)
  const power = (): number => {
    const base = primary();
    if (isOp('^')) {
      pos++;
      return base ** unary();
    }
    return base;
  };
  const primary = (): number => {
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
          args.push(expr());
          while (isOp(',')) {
            pos++;
            args.push(expr());
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
      const v = expr();
      expect(')');
      return v;
    }
    throw new Error(`Unexpected "${tok.value}"`);
  };

  const result = expr();
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].value}"`);
  if (!Number.isFinite(result)) throw new Error('Result is not a finite number');
  return result;
}
