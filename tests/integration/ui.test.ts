import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../../src/storage/store.js';
import { tempDir } from '../support/fixtures.js';
import { startServer } from '../support/http.js';
import { ScriptedModel } from '../support/scripted.js';

describe('browser UI build', () => {
  let cleanup: () => Promise<void>;
  let outDir: string;
  let server: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    outDir = path.join(t.dir, 'web');
    await build({ configFile: path.resolve('vite.config.ts'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    server = await startServer({ store: new Store(path.join(t.dir, 'data')), llm: new ScriptedModel({}), models: { coordinator: 'c', writer: 'w', critic: 'r' }, staticDir: outDir });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    await cleanup?.();
  });

  it('builds and is served with its assets', async () => {
    const html = await (await fetch(server.url)).text();
    expect(html).toContain('<title>CV Writer</title>');
    const assets = await readdir(path.join(outDir, 'assets'));
    const js = assets.find((a) => a.endsWith('.js'))!;
    const css = assets.find((a) => a.endsWith('.css'))!;
    expect(html).toContain(`/assets/${js}`);
    const script = await (await fetch(`${server.url}/assets/${js}`)).text();
    // The shared CV renderer is bundled for instant style previews.
    expect(script).toContain('cv-bullets');
    expect((await fetch(`${server.url}/assets/${css}`)).headers.get('content-type')).toMatch(/text\/css/);
  });
});
