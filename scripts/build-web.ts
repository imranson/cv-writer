import { build } from 'esbuild';

await build({
  entryPoints: ['web/src/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'public/app.js',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  logLevel: 'info',
});
