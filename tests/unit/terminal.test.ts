import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { TerminalIO } from '../../src/app/terminal.js';

function setup(pasteWindowMs = 0) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => (written += chunk.toString()));
  const io = new TerminalIO({ input, output, pasteWindowMs, color: false });
  return { io, input, output: () => written };
}

describe('TerminalIO', () => {
  it('returns one message per line for piped input, skipping blank lines', async () => {
    const { io, input } = setup(0);
    input.write('first\n\nsecond\n');
    expect(await io.readUserInput()).toBe('first');
    expect(await io.readUserInput()).toBe('second');
    io.close();
  });

  it('joins lines that arrive together (a paste) into one message', async () => {
    const { io, input } = setup(30);
    const reply = io.readUserInput();
    input.write('Job title: Engineer\nCompany: Acme\n\nWe need Python.\n');
    expect(await reply).toBe('Job title: Engineer\nCompany: Acme\n\nWe need Python.');
    io.close();
  });

  it('collects a """ block as one message', async () => {
    const { io, input, output } = setup(0);
    const reply = io.readUserInput();
    input.write('"""\nline one\n\nline two\n"""\n');
    expect(await reply).toBe('line one\n\nline two');
    expect(output()).toContain('Multi-line mode');
    io.close();
  });

  it('returns pending messages and then null once input ends', async () => {
    const { io, input } = setup(0);
    input.end('last words\n');
    expect(await io.readUserInput()).toBe('last words');
    expect(await io.readUserInput()).toBeNull();
  });

  it('flushes an unterminated block at end of input', async () => {
    const { io, input } = setup(0);
    input.end('"""\npartial\n');
    expect(await io.readUserInput()).toBe('partial');
    expect(await io.readUserInput()).toBeNull();
  });

  it('prints the prompt, coordinator messages and status lines', async () => {
    const { io, input, output } = setup(0);
    io.say('Hello there');
    io.status('Reading your profile');
    const reply = io.readUserInput();
    input.write('hi\n');
    await reply;
    expect(output()).toContain('\nCV Writer\nHello there\n\n');
    expect(output()).toContain('  · Reading your profile\n');
    expect(output()).toContain('you › ');
    io.close();
  });
});
