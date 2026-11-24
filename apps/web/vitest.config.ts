import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default defineConfig((env) =>
  mergeConfig(viteConfig({ ...env, mode: 'test' }), {
    root: import.meta.dirname,
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}', '*.test.ts'],
      // Playwright specs (e2e/*.spec.ts) run with `npm run test:e2e`, never under Vitest
      exclude: [...configDefaults.exclude, 'e2e/**'],
      setupFiles: ['src/test/setup.ts'],
      css: false,
      restoreMocks: true,
    },
  }),
);
