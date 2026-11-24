import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  resolve: { conditions: ['@neurouter/source'] },
  ssr: { resolve: { conditions: ['@neurouter/source'] } },
  test: {
    name: 'server',
    include: ['src/**/*.test.ts', 'test-utils/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    env: { NODE_ENV: 'test' },
  },
});
