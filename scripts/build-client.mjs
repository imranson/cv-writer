// Bundles the browser client (src/client) and copies static assets (web/) into dist/public.
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const outdir = 'dist/public';
await mkdir(outdir, { recursive: true });
await cp('web', outdir, { recursive: true });
await build({
  entryPoints: ['src/client/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  outfile: `${outdir}/app.js`,
  logLevel: 'info',
});
