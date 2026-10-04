import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ChatIO } from './session.js';

export const BLOCK_DELIMITER = '"""';

export interface TerminalIOOptions {
  input: Readable;
  output: Writable;
  /**
   * Lines arriving within this window are joined into one message, so a pasted
   * job listing arrives whole. 0 treats every line as its own message (piped input).
   */
  pasteWindowMs?: number;
  color?: boolean;
  /** Ctrl+C while the agent is working. */
  onInterrupt?: () => void;
}

const isTTY = (s: Readable | Writable) => Boolean((s as { isTTY?: boolean }).isTTY);

export class TerminalIO implements ChatIO {
  private readonly rl: readline.Interface;
  private readonly output: Writable;
  private readonly pasteWindowMs: number;
  private readonly color: boolean;
  private readonly messages: string[] = [];
  private buffer: string[] = [];
  private blockMode = false;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;
  private waiter: ((value: string | null) => void) | undefined;

  constructor(options: TerminalIOOptions) {
    const tty = isTTY(options.input) && isTTY(options.output);
    this.output = options.output;
    this.pasteWindowMs = options.pasteWindowMs ?? (tty ? 40 : 0);
    this.color = options.color ?? tty;
    this.rl = readline.createInterface({ input: options.input, output: options.output, terminal: tty });
    this.rl.setPrompt(this.paint('1;32', 'you › '));
    this.rl.on('line', (line) => this.onLine(line));
    this.rl.on('close', () => {
      this.closed = true;
      this.commit();
      this.deliver();
    });
    this.rl.on('SIGINT', () => {
      if (this.waiter) this.rl.close();
      else options.onInterrupt?.();
    });
  }

  readUserInput(): Promise<string | null> {
    if (!this.closed) this.rl.prompt();
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.deliver();
    });
  }

  say(text: string): void {
    this.output.write(`\n${this.paint('1;36', 'CV Writer')}\n${text}\n\n`);
  }

  status(text: string): void {
    this.output.write(`${this.paint('2', `  · ${text}`)}\n`);
  }

  close(): void {
    this.rl.close();
  }

  private onLine(line: string): void {
    if (line.trim() === BLOCK_DELIMITER) {
      this.blockMode = !this.blockMode;
      if (this.blockMode) this.status(`Multi-line mode: finish with ${BLOCK_DELIMITER} on its own line.`);
      else this.commit();
      return;
    }
    this.buffer.push(line);
    if (this.blockMode) return;
    if (this.pasteWindowMs <= 0) return this.commit();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.commit(), this.pasteWindowMs);
  }

  private commit(): void {
    clearTimeout(this.timer);
    const text = this.buffer.join('\n').trim();
    this.buffer = [];
    if (text) this.messages.push(text);
    else if (this.waiter && !this.closed && !this.blockMode) this.rl.prompt();
    this.deliver();
  }

  private deliver(): void {
    if (!this.waiter) return;
    const next = this.messages.shift();
    if (next !== undefined) {
      this.resolve(next);
    } else if (this.closed) {
      this.resolve(null);
    }
  }

  private resolve(value: string | null): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(value);
  }

  private paint(code: string, text: string): string {
    return this.color ? `\u001b[${code}m${text}\u001b[0m` : text;
  }
}
