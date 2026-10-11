/**
 * Safe arithmetic evaluator (no `eval`). Supports + - * / % ^, parentheses,
 * unary minus, constants (pi, e) and common functions.
 */

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  round: (x, digits = 0) => {
    const f = 10 ** digits;
    return Math.round(x * f) / f;
  },
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  exp: Math.exp,
  ln: Math.log,
  log: (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)),
  log2: Math.log2,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const match = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(input.slice(i));
      if (!match) throw new Error(`Invalid number at position ${i}`);
      tokens.push({ kind: 'num', value: Number(match[0]) });
      i += match[0].length;
    } else if (/[a-z_]/i.test(ch)) {
      const match = /^[a-z_][a-z0-9_]*/i.exec(input.slice(i))!;
      tokens.push({ kind: 'ident', value: match[0].toLowerCase() });
      i += match[0].length;
    } else if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i++;
    } else {
      throw new Error(`Unexpected character "${ch}" at position ${i}`);
    }
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

  // expression := term (('+' | '-') term)*
  private expression(): number {
    let value = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.tokens[this.pos++].value;
      const rhs = this.term();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  // term := unary (('*' | '/' | '%') unary)*
  private term(): number {
    let value = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.tokens[this.pos++].value;
      const rhs = this.unary();
      if (op === '*') value *= rhs;
      else if (op === '/') {
        if (rhs === 0) throw new Error('Division by zero');
        value /= rhs;
      } else value %= rhs;
    }
    return value;
  }

  // unary := ('-' | '+') unary | power
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

  // power := primary ('^' unary)?   (right associative)
  private power(): number {
    const base = this.primary();
    if (this.isOp('^')) {
      this.pos++;
      return base ** this.unary();
    }
    return base;
  }

  private primary(): number {
    const token = this.peek();
    if (!token) throw new Error('Unexpected end of expression');
    if (token.kind === 'num') {
      this.pos++;
      return token.value;
    }
    if (token.kind === 'ident') {
      this.pos++;
      if (this.isOp('(')) {
        const fn = Object.hasOwn(FUNCTIONS, token.value) ? FUNCTIONS[token.value] : undefined;
        if (!fn) throw new Error(`Unknown function "${token.value}"`);
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
      if (Object.hasOwn(CONSTANTS, token.value)) return CONSTANTS[token.value];
      throw new Error(`Unknown identifier "${token.value}"`);
    }
    if (token.value === '(') {
      this.pos++;
      const value = this.expression();
      this.expect(')');
      return value;
    }
    throw new Error(`Unexpected token "${token.value}"`);
  }
}

export function evaluateMath(expression: string): number {
  const result = new Parser(tokenize(expression)).parse();
  if (!Number.isFinite(result)) throw new Error('Result is not a finite number');
  return result;
}
