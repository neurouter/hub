/**
 * Playwright e2e suite (apps/web/e2e), derived from the agent-browser traces in
 * .agent/reports/e2e-traces. `webServer` boots the *built* gateway (server + SPA, SQLite in a
 * temp dir, dev login) and the fake upstream MCP servers on free ports. Build first:
 * `npm run build` (the root `npm run test:e2e` does it for you).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });

// Workers re-evaluate this file: pick ports, data dir and keys once, in the runner, and hand
// them to workers through the environment they inherit.
if (!process.env.E2E_GW_PORT) {
  process.env.E2E_GW_PORT = String(await freePort());
  process.env.E2E_UPSTREAM_PORT = String(await freePort());
  process.env.E2E_DATA_DIR = mkdtempSync(join(tmpdir(), 'neurouter-e2e-'));
  process.env.E2E_MASTER_KEYS = `k1:${randomBytes(32).toString('base64')}`;
  process.env.E2E_HASH_PEPPER = randomBytes(32).toString('hex');
}
const gwPort = process.env.E2E_GW_PORT;
const upstreamPort = process.env.E2E_UPSTREAM_PORT!;
const baseURL = `http://localhost:${gwPort}`;
process.env.E2E_BASE_URL = baseURL;
process.env.E2E_UPSTREAM_URL = `http://127.0.0.1:${upstreamPort}`;

const serverDir = resolve(import.meta.dirname, '../server');

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalTeardown: './e2e/support/global-teardown.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    timezoneId: 'UTC',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      name: 'upstream',
      command: 'node e2e/support/upstream-server.ts',
      url: `http://127.0.0.1:${upstreamPort}/healthz`,
      env: { ...process.env, E2E_UPSTREAM_PORT: upstreamPort } as Record<string, string>,
      reuseExistingServer: false,
      stdout: 'ignore',
    },
    {
      name: 'gateway',
      command: 'node --import ./dist/instrumentation.js dist/main.js',
      cwd: serverDir,
      url: `${baseURL}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      // E2E_SERVER_LOGS=1 pipes the gateway's logs into the test output
      stdout: process.env.E2E_SERVER_LOGS ? 'pipe' : 'ignore',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      env: {
        ...process.env,
        NODE_ENV: 'development',
        NEUROUTER_ENV_FILE: '/dev/null',
        HOST: '127.0.0.1',
        PORT: gwPort,
        PUBLIC_URL: baseURL,
        // E2E_DATABASE_URL runs the suite against another database (e.g. an empty Postgres)
        DATABASE_URL: process.env.E2E_DATABASE_URL || `sqlite:${join(process.env.E2E_DATA_DIR!, 'neurouter.db')}`,
        NEUROUTER_MASTER_KEYS: process.env.E2E_MASTER_KEYS,
        NEUROUTER_ACTIVE_KEY_ID: 'k1',
        HASH_PEPPER: process.env.E2E_HASH_PEPPER,
        BOOTSTRAP_ADMIN_EMAIL: 'admin@e2e.test',
        AUTH_DEV_LOGIN: 'true',
        SERVE_WEB: 'true',
        EMBEDDINGS_ALLOW_REMOTE: 'false',
        OTEL_SDK_DISABLED: 'true',
        LOG_PRETTY: 'false',
        LOG_LEVEL: process.env.E2E_SERVER_LOGS ? 'error' : 'warn',
      } as Record<string, string>,
    },
  ],
});
