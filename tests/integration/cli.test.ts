import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { USAGE } from '../../src/config.js';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const cli = (...args: string[]) =>
  run(process.execPath, ['--import', 'tsx', path.join(root, 'src/index.ts'), ...args], { cwd: root });

describe('cli', () => {
  it('prints usage with --help', async () => {
    const { stdout } = await cli('--help');
    expect(stdout.trim()).toBe(USAGE);
  });

  it('exits non-zero with a message on bad arguments', async () => {
    await expect(cli('--budget', 'lots')).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/Invalid budget/) });
  });
});
