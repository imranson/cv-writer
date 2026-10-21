import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: process.env.LIVE_OLLAMA ? [] : ['tests/live/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    environment: 'node',
  },
});
