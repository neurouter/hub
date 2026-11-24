import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { apiPlugins } from './api/plugin.js';
import { createServices, initServices } from './deps.js';
import { registerJobs } from './jobs/registry.js';
import { ConfigError, loadConfig, loadDotenv } from './config/load.js';
import pg from 'pg';
import { MemoryCoordination } from './coordination/memory.js';
import { PostgresCoordination } from './coordination/postgres.js';
import type { CoordinationStore } from './coordination/types.js';
import { createDatabases, migrateAll } from './db/index.js';
import { redactDatabaseUrl } from './db/url.js';
import { JobScheduler } from './jobs/scheduler.js';
import { systemClock } from './lib/clock.js';
import { createLogger } from './lib/logger.js';
import { SERVER_VERSION } from './version.js';

/** loadConfig → createDb → migrate → build deps → buildApp → listen → start jobs; graceful shutdown. */
async function main(): Promise<void> {
  const envFile = loadDotenv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({ level: config.env.LOG_LEVEL, pretty: config.env.LOG_PRETTY, instanceId: config.instanceId });
  if (envFile) logger.info({ envFile }, 'loaded .env');
  for (const w of config.warnings) logger.warn(w);

  const dbs = createDatabases({
    databaseUrl: config.databaseUrl,
    auditDatabaseUrl: config.auditDatabaseUrl,
    poolMax: config.env.DB_POOL_MAX,
    auditPoolMax: config.env.AUDIT_DB_POOL_MAX,
    onWarn: (msg, err) => logger.warn({ err }, msg),
  });
  logger.info(
    {
      dialect: dbs.main.dialect,
      database: redactDatabaseUrl(config.databaseUrl),
      auditDatabase: config.separateAuditDb ? redactDatabaseUrl(config.auditDatabaseUrl) : 'same as DATABASE_URL',
    },
    'database configured',
  );

  if (config.env.MIGRATE_ON_START) {
    const applied = await migrateAll(dbs, { embeddingDims: config.env.EMBEDDINGS_DIMS });
    logger.info({ main: applied.main, audit: applied.audit }, applied.main.length + applied.audit.length ? 'migrations applied' : 'schema up to date');
  }

  let coordination: CoordinationStore = new MemoryCoordination(systemClock);
  if (config.env.COORDINATION_BACKEND === 'postgres' || (config.env.COORDINATION_BACKEND === 'auto' && dbs.main.dialect === 'postgres')) {
    if (dbs.main.dialect !== 'postgres') throw new Error('COORDINATION_BACKEND=postgres requires a Postgres DATABASE_URL');
    const pgc = new PostgresCoordination(dbs.main.db, systemClock, () => new pg.Client({ connectionString: config.databaseUrl, application_name: 'neurouter-listen' }), logger);
    await pgc.start();
    coordination = pgc;
    logger.info('coordination: postgres (LISTEN/NOTIFY + leases)');
  }

  const scheduler = new JobScheduler(coordination, config.instanceId, logger);
  const services = createServices({ config, logger, dbs, clock: systemClock, coordination, version: SERVER_VERSION });
  const auditStore = services.auditStore;
  if (services.archive) logger.info({ archive: services.archive.location }, 'audit archive enabled');
  await initServices(services);
  registerJobs(scheduler, services);

  const app: FastifyInstance = await buildApp({ config, logger, dbs, auditStore, clock: systemClock, version: SERVER_VERSION, apiPlugins: apiPlugins(services) });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      process.exit(1);
    }, 20_000);
    timer.unref();
    try {
      await app.close();
      await scheduler.stop();
      await services.shutdown();
      await coordination.close();
      await dbs.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.env.HOST, port: config.env.PORT });
  scheduler.start();
  // the embedding model loads in a worker in the background; search is keyword-only until it is ready
  if (services.embedder.status() === 'idle') services.embedder.warmUp();
  logger.info({ publicUrl: config.publicUrl, version: SERVER_VERSION, serveWeb: config.serveWeb }, 'neurouter server ready');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
