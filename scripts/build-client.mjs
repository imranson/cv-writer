// Bundles the browser client (src/client/main.ts) into public/app.js.
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/client/main.ts'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: 'public/app.js',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
