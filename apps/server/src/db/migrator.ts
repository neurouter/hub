import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from 'kysely/migration';
import { AUDIT_MIGRATIONS, MAIN_MIGRATIONS, MIGRATION_TABLES, type MigrationSet } from './migrations/index.js';
import type { DialectMigration, MigrationContext } from './migrations/types.js';

/** Static-import-map provider (no fs scanning; bundler-safe). Binds each migration to its dialect context. */
export class StaticMigrationProvider implements MigrationProvider {
  constructor(
    private readonly migrations: readonly DialectMigration[],
    private readonly ctx: MigrationContext,
  ) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const out: Record<string, Migration> = {};
    for (const m of this.migrations) {
      if (out[m.name]) throw new Error(`Duplicate migration name ${m.name}`);
      out[m.name] = { up: (db) => m.up(db, this.ctx), down: (db) => m.down(db, this.ctx) };
    }
    return out;
  }
}

export function migrationsFor(set: MigrationSet): readonly DialectMigration[] {
  return set === 'main' ? MAIN_MIGRATIONS : AUDIT_MIGRATIONS;
}

export function createMigrator(db: Kysely<unknown>, set: MigrationSet, ctx: MigrationContext): Migrator {
  return new Migrator({
    db,
    provider: new StaticMigrationProvider(migrationsFor(set), ctx),
    migrationTableName: MIGRATION_TABLES[set].table,
    migrationLockTableName: MIGRATION_TABLES[set].lock,
    allowUnorderedMigrations: false,
  });
}

export class MigrationError extends Error {
  constructor(message: string, public readonly results: MigrationResultSet['results']) {
    super(message);
    this.name = 'MigrationError';
  }
}

function unwrap(set: MigrationSet, res: MigrationResultSet): string[] {
  if (res.error) {
    const failed = res.results?.find((r) => r.status === 'Error');
    const cause = res.error instanceof Error ? res.error.message : String(res.error);
    throw new MigrationError(`${set} migration ${failed?.migrationName ?? '(unknown)'} failed: ${cause}`, res.results);
  }
  return (res.results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/**
 * Applies pending migrations under Kysely's DB-level lock (safe with many replicas).
 * Returns the names applied.
 */
export async function migrateToLatest(db: Kysely<unknown>, set: MigrationSet, ctx: MigrationContext): Promise<string[]> {
  return unwrap(set, await createMigrator(db, set, ctx).migrateToLatest());
}

/** Dev only: rolls back the latest migration of a set. */
export async function migrateDown(db: Kysely<unknown>, set: MigrationSet, ctx: MigrationContext): Promise<string[]> {
  return unwrap(set, await createMigrator(db, set, ctx).migrateDown());
}

export async function migrationStatus(db: Kysely<unknown>, set: MigrationSet, ctx: MigrationContext) {
  const infos = await createMigrator(db, set, ctx).getMigrations();
  return infos.map((m) => ({ name: m.name, executedAt: m.executedAt ?? null }));
}
