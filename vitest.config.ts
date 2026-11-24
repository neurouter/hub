import { defineConfig } from 'vitest/config';

/** Root Vitest config: one project per workspace (unit tests only, decision 36). */
export default defineConfig({
  test: {
    projects: ['packages/shared/vitest.config.ts', 'apps/server/vitest.config.ts', 'apps/web/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      exclude: ['**/dist/**', '**/*.test.*', '**/test/**', 'apps/web/src/components/ui/**', 'apps/web/src/routeTree.gen.ts'],
    },
  },
});
