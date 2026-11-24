import type { Kysely } from 'kysely';
import { createDatabases, migrateAll, type Databases } from '../../db/index.js';
import type { AuditDB, MainDB } from '../../db/schema.js';

export const TEST_EMBEDDING_DIMS = 384;

/** Fresh in-memory SQLite (sqlite-vec loaded) with every migration applied. Main and audit share it. */
export async function createTestDatabases(): Promise<Databases> {
  const dbs = createDatabases({ databaseUrl: 'sqlite::memory:' });
  await migrateAll(dbs, { embeddingDims: TEST_EMBEDDING_DIMS });
  return dbs;
}

export async function createTestDb(): Promise<{ db: Kysely<MainDB>; audit: Kysely<AuditDB>; close: () => Promise<void> }> {
  const dbs = await createTestDatabases();
  return { db: dbs.main.db, audit: dbs.audit.db, close: () => dbs.close() };
}
