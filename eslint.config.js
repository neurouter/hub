// ESLint flat config (ESLint 10 + typescript-eslint 8.74, TS 6.0.3 pinned per decision 39).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import pluginQuery from '@tanstack/eslint-plugin-query';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'apps/web/src/routeTree.gen.ts',
      'apps/web/public/mockServiceWorker.js',
      'apps/server/data/**',
      'tmp/**',
      '.agent/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'off',
    },
  },
  {
    files: ['apps/server/**/*.ts', 'scripts/**/*.{js,mjs}', '*.{js,ts}', 'packages/shared/vitest.config.ts', 'apps/web/vite.config.ts', 'apps/web/vitest.config.ts', 'apps/web/playwright.config.ts', 'apps/web/e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // packages/shared is isomorphic: no Node built-ins, no server-only libraries.
    files: ['packages/shared/src/**/*.ts'],
    ignores: ['packages/shared/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/shared must stay isomorphic (no Node built-ins).' },
            { group: ['fs', 'path', 'crypto', 'os', 'child_process', 'http', 'https', 'net', 'url', 'stream', 'buffer'], message: 'packages/shared must stay isomorphic.' },
            { group: ['fastify*', 'kysely*', 'pg', 'better-sqlite3', 'pino*', 'react*'], message: 'packages/shared may only depend on zod.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', { name: 'Buffer', message: 'Not available in browsers.' }, { name: 'process', message: 'Not available in browsers.' }],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, '@tanstack/query': pluginQuery },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...pluginQuery.configs['flat/recommended'][0]?.rules,
      'no-restricted-syntax': [
        'error',
        { selector: "Literal[value=/localhost|127\\.0\\.0\\.1/]", message: 'No hardcoded hosts in apps/web: the app is same-origin.' },
      ],
    },
  },
  {
    // shadcn-generated code (CLI-owned; keep local edits minimal)
    files: ['apps/web/src/components/ui/**/*.{ts,tsx}', 'apps/web/src/hooks/use-mobile.ts'],
    rules: { 'react-hooks/purity': 'off', 'react-hooks/set-state-in-effect': 'off' },
  },
  {
    files: ['apps/web/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser }, sourceType: 'script' },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-syntax': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
