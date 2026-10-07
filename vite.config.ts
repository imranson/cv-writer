import { defineConfig } from 'vite';

// The browser UI is plain TypeScript; the API server (src/server) serves the built files from dist/web.
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:5174' } },
});
