import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client/main.ts');

/** Bundles the TypeScript browser client with esbuild. Cached unless `rebuild` is set (dev). */
export function createClientBundler(options: { rebuild?: boolean } = {}): () => Promise<string> {
  let cached: Promise<string> | undefined;
  const bundle = async () => {
    const result = await build({
      entryPoints: [ENTRY],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      write: false,
      sourcemap: options.rebuild ? 'inline' : false,
      minify: !options.rebuild,
      logLevel: 'silent',
    });
    return result.outputFiles[0].text;
  };
  return () => {
    if (options.rebuild) return bundle();
    cached ??= bundle().catch((err) => {
      cached = undefined;
      throw err;
    });
    return cached;
  };
}
