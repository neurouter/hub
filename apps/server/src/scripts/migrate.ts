/**
 * Migration CLI: `npm run db:migrate -- [up|down|status] [--set main|audit]`.
 * `up` applies both sets (main → DATABASE_URL, audit → AUDIT_DATABASE_URL). `down` is dev-only.
 */
import type { Kysely } from 'kysely';
import { ConfigError, loadConfig, loadDotenv } from '../config/load.js';
import { createDatabases, migrateAll } from '../db/index.js';
import { migrateDown, migrationStatus } from '../db/migrator.js';
import type { MigrationSet } from '../db/migrations/index.js';

async function run(argv: string[]): Promise<number> {
  loadDotenv();
  const config = loadConfig();
  const cmd = argv.find((a) => !a.startsWith('--')) ?? 'up';
  const setArg = argv.find((a) => a.startsWith('--set='))?.slice(6) ?? (argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : undefined);
  const sets: MigrationSet[] = setArg === 'main' || setArg === 'audit' ? [setArg] : ['main', 'audit'];
  const dbs = createDatabases({ databaseUrl: config.databaseUrl, auditDatabaseUrl: config.auditDatabaseUrl });
  const ctxFor = (set: MigrationSet) => ({ dialect: set === 'main' ? dbs.main.dialect : dbs.audit.dialect, embeddingDims: config.env.EMBEDDINGS_DIMS });
  const handle = (set: MigrationSet) => (set === 'main' ? dbs.main.db : dbs.audit.db) as Kysely<unknown>;
  try {
    if (cmd === 'up') {
      const applied = await migrateAll(dbs, { embeddingDims: config.env.EMBEDDINGS_DIMS });
      console.log(JSON.stringify(applied, null, 2));
    } else if (cmd === 'down') {
      if (config.isProduction) throw new Error('down migrations are disabled in production (forward-only)');
      for (const set of sets.reverse()) console.log(set, await migrateDown(handle(set), set, ctxFor(set)));
    } else if (cmd === 'status') {
      for (const set of sets) {
        console.log(`[${set}]`);
        for (const m of await migrationStatus(handle(set), set, ctxFor(set)))
          console.log(`  ${m.executedAt ? 'applied ' + m.executedAt.toISOString() : 'pending'}  ${m.name}`);
      }
    } else {
      console.error(`Unknown command "${cmd}". Use up | down | status.`);
      return 2;
    }
    return 0;
  } finally {
    await dbs.close();
  }
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  },
);
