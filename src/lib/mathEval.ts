/**
 * Safe arithmetic evaluator (no `eval`). Supports + - * / % ^, unary minus,
 * parentheses, constants (pi, e) and a whitelist of functions.
 */

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'id'; value: string }
  | { kind: 'op'; value: string };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: (x: number, digits = 0) => {
    const f = 10 ** digits;
    return Math.round(x * f) / f;
  },
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  log2: Math.log2,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sum: (...xs: number[]) => xs.reduce((a, b) => a + b, 0),
  avg: (...xs: number[]) => {
    if (xs.length === 0) throw new Error('avg() needs at least one argument');
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  },
};
FUNCTIONS.mean = FUNCTIONS.avg;

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // "_" may be used as a digit separator (1_000_000); "," always separates function arguments.
    const num = /^(?:\d[\d_]*(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      tokens.push({ kind: 'num', value: Number(num[0].replace(/_/g, '')) });
      i += num[0].length;
      continue;
    }
    const id = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i));
    if (id) {
      tokens.push({ kind: 'id', value: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    if (src.startsWith('**', i)) {
      tokens.push({ kind: 'op', value: '^' });
      i += 2;
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" at position ${i}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    if (this.tokens.length === 0) throw new Error('Empty expression');
    const value = this.expression();
    if (this.pos < this.tokens.length) throw new Error(`Unexpected token "${this.tokens[this.pos].value}"`);
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t?.kind === 'op' && t.value === value;
  }

  private expect(value: string): void {
    if (!this.isOp(value)) throw new Error(`Expected "${value}"`);
    this.pos++;
  }

  private expression(): number {
    let left = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.tokens[this.pos++] as { value: string }).value;
      const right = this.term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private term(): number {
    let left = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.tokens[this.pos++] as { value: string }).value;
      const right = this.unary();
      if (op === '*') left *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        left /= right;
      } else left %= right;
    }
    return left;
  }

  private unary(): number {
    if (this.isOp('-')) {
      this.pos++;
      return -this.unary();
    }
    if (this.isOp('+')) {
      this.pos++;
      return this.unary();
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    if (this.isOp('^')) {
      this.pos++;
      return base ** this.unary(); // right-associative, binds tighter than unary on the left
    }
    return base;
  }

  private primary(): number {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.kind === 'num') {
      this.pos++;
      return t.value;
    }
    if (t.kind === 'op' && t.value === '(') {
      this.pos++;
      const v = this.expression();
      this.expect(')');
      return v;
    }
    if (t.kind === 'id') {
      this.pos++;
      if (this.isOp('(')) {
        const fn = FUNCTIONS[t.value];
        if (!fn) throw new Error(`Unknown function "${t.value}"`);
        this.pos++;
        const args: number[] = [];
        if (!this.isOp(')')) {
          args.push(this.expression());
          while (this.isOp(',')) {
            this.pos++;
            args.push(this.expression());
          }
        }
        this.expect(')');
        return fn(...args);
      }
      if (t.value in CONSTANTS) return CONSTANTS[t.value];
      throw new Error(`Unknown identifier "${t.value}"`);
    }
    throw new Error(`Unexpected token "${t.value}"`);
  }
}

export function evaluateMath(expression: string): number {
  if (expression.length > 2000) throw new Error('Expression too long');
  const result = new Parser(tokenize(expression)).parse();
  if (!Number.isFinite(result)) throw new Error('Result is not a finite number');
  return result;
}
