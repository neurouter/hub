import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';
import { buildDevProxy, parseDevPort } from './dev-proxy.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // .env lives at the repo root (shared with the server); env files are not in process.env here.
  const env = { ...loadEnv(mode, repoRoot, ''), ...process.env };
  const serve = command === 'serve' && mode !== 'test';
  // `npm run build:demo`: the console against MSW fixtures as a static, read-only demo site
  const demo = env.VITE_DEMO === 'true';
  return {
    plugins: [
      // must come before react() (TanStack Router docs)
      tanstackRouter({ target: 'react', autoCodeSplitting: true, routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts' }),
      react(),
      tailwindcss(),
      // serves the MSW worker in dev (VITE_ENABLE_MSW=true) and emits it into the demo build only;
      // never part of the production build the gateway serves
      ...((serve && env.VITE_ENABLE_MSW === 'true') || demo ? [msw({ mode: 'worker-only' })] : []),
    ],
    envDir: repoRoot,
    resolve: {
      alias: { '@': resolve(import.meta.dirname, 'src') },
      // consume @neurouter/shared from source (no build step in dev); keep Vite's defaults
      // ('browser' among them) so packages like msw resolve to their browser builds
      conditions: ['@neurouter/source', ...defaultClientConditions],
    },
    server: serve
      ? {
          port: parseDevPort(env.NEUROUTER_WEB_DEV_PORT),
          strictPort: false,
          proxy: buildDevProxy(env.NEUROUTER_DEV_API_URL),
        }
      : {},
    build: { outDir: demo ? 'dist-demo' : 'dist', emptyOutDir: true, sourcemap: !demo },
  };
});
