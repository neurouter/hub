import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import { defineConfig, loadEnv } from 'vite';
import { buildDevProxy, parseDevPort } from './dev-proxy.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // .env lives at the repo root (shared with the server); env files are not in process.env here.
  const env = { ...loadEnv(mode, repoRoot, ''), ...process.env };
  const serve = command === 'serve' && mode !== 'test';
  return {
    plugins: [
      // must come before react() (TanStack Router docs)
      tanstackRouter({ target: 'react', autoCodeSplitting: true, routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts' }),
      react(),
      tailwindcss(),
      // serves the MSW worker in dev only (VITE_ENABLE_MSW=true); never part of the production build
      ...(serve && env.VITE_ENABLE_MSW === 'true' ? [msw({ mode: 'worker-only' })] : []),
    ],
    envDir: repoRoot,
    resolve: {
      alias: { '@': resolve(import.meta.dirname, 'src') },
      // consume @neurouter/shared from source (no build step in dev)
      conditions: ['@neurouter/source'],
    },
    server: serve
      ? {
          port: parseDevPort(env.NEUROUTER_WEB_DEV_PORT),
          strictPort: false,
          proxy: buildDevProxy(env.NEUROUTER_DEV_API_URL),
        }
      : {},
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  };
});
