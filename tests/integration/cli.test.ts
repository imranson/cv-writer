import { execFile, spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { USAGE } from '../../src/config.js';
import { tempDir } from '../helpers.js';
import { startFakeOllama } from '../support/fakeOllama.js';

const root = path.resolve(import.meta.dirname, '../..');
const entry = ['--import', 'tsx', path.join(root, 'src/index.ts')];
const { OLLAMA_API_KEY: _key, OLLAMA_HOST: _host, CV_WRITER_MODEL: _m, CV_WRITER_WRITER_MODEL: _w, ...cleanEnv } = process.env;

const run = promisify(execFile);
const cli = (...args: string[]) => run(process.execPath, [...entry, ...args], { cwd: root, env: cleanEnv });

/** Runs the CLI with the given stdin, resolving with its output once it exits. */
function session(args: string[], stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...entry, ...args], { cwd: root, env: cleanEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/** A port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('cli', () => {
  it('prints usage with --help', async () => {
    const { stdout } = await cli('--help');
    expect(stdout.trim()).toBe(USAGE);
  });

  it('exits non-zero with a message on bad arguments', async () => {
    await expect(cli('--think', 'lots')).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/Invalid --think "lots"/) });
    await expect(cli('--resume', 'session-missing', '--data', await tempDir())).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/No saved conversation "session-missing"/),
    });
  });

  it('holds a conversation over stdin/stdout against an Ollama server and saves everything', async () => {
    const ollama = await startFakeOllama([
      { message: { content: 'Welcome! What is your name?' } },
      { message: { tool_calls: [{ id: 'c1', function: { name: 'update_contact', arguments: { name: 'Sam Lee' } } }] } },
      { message: { content: 'Thanks, Sam. Saved.' } },
    ]);
    servers.push(ollama);
    const data = await tempDir();

    const { code, stdout } = await session(
      ['--host', ollama.url, '--data', data, '--model', 'coord:cloud', '--writer-model', 'writer:cloud'],
      'My name is Sam Lee\n/quit\n',
    );

    expect(code).toBe(0);
    expect(stdout).toContain(`CV Writer · coord:cloud + writer:cloud via ${ollama.url}`);
    expect(stdout).toContain('Coordinator\nWelcome! What is your name?');
    expect(stdout).toContain('· Saving your contact details');
    expect(stdout).toContain('Coordinator\nThanks, Sam. Saved.');
    expect(stdout).toMatch(/Session ended · 2 turns · 3 model calls/);
    expect(stdout).toMatch(/npm start -- --resume session-[a-f0-9]{6}/);

    expect(ollama.requests.map((r) => r.body.model)).toEqual(['coord:cloud', 'coord:cloud', 'coord:cloud']);
    const profile = JSON.parse(await readFile(path.join(data, 'profile.json'), 'utf8'));
    expect(profile.contact.name).toBe('Sam Lee');
    const [sessionFile] = await readdir(path.join(data, 'sessions'));
    const saved = JSON.parse(await readFile(path.join(data, 'sessions', sessionFile!), 'utf8'));
    expect(saved.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
  });

  it('explains how to fix an unreachable Ollama and exits non-zero', async () => {
    const host = `http://127.0.0.1:${await closedPort()}`;
    const { code, stdout } = await session(['--host', host, '--data', await tempDir()], '');
    expect(code).toBe(1);
    expect(stdout).toContain(`Can't reach Ollama at ${host} (ECONNREFUSED)`);
  });
});
