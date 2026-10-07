import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], environment: 'node', testTimeout: 60_000 } },
      { test: { name: 'live', include: ['tests/live/**/*.live.test.ts'], environment: 'node', testTimeout: 1_800_000, hookTimeout: 60_000 } },
    ],
  },
});
