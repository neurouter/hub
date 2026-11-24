import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../app.js';
import { SqlAuditStore } from '../../audit/store.js';
import { loadConfig, type Config } from '../../config/load.js';
import { createDatabases, type Databases } from '../../db/index.js';
import { systemClock } from '../../lib/clock.js';
import { createLogger } from '../../lib/logger.js';
import { createTestDatabases } from './test-db.js';

export interface TestApp {
  app: FastifyInstance;
  dbs: Databases;
  config: Config;
  logs: string[];
  close(): Promise<void>;
}

/** Builds the real app on in-memory SQLite with a captured logger (for fastify.inject tests). */
export async function createTestApp(
  opts: { env?: Record<string, string>; migrate?: boolean; apiPlugins?: AppDeps['apiPlugins'] } = {},
): Promise<TestApp> {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'warn', ...opts.env });
  const dbs = opts.migrate === false ? createDatabases({ databaseUrl: 'sqlite::memory:' }) : await createTestDatabases();
  const logs: string[] = [];
  const dest = new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } });
  const logger = createLogger({ level: config.env.LOG_LEVEL, pretty: false }, dest as never);
  const app = await buildApp({
    config,
    logger,
    dbs,
    auditStore: new SqlAuditStore(dbs.audit.db, dbs.audit.dialect),
    clock: systemClock,
    version: '0.0.0-test',
    ...(opts.apiPlugins ? { apiPlugins: opts.apiPlugins } : {}),
  });
  await app.ready();
  return {
    app, dbs, config, logs,
    async close() {
      await app.close();
      await dbs.close();
    },
  };
}
