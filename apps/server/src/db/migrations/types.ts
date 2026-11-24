import type { Kysely } from 'kysely';
import type { Dialect } from '../url.js';

export interface MigrationContext {
  dialect: Dialect;
  /** Embedding vector dimensions (pgvector column size). */
  embeddingDims: number;
}

/** A migration that branches explicitly where SQL differs per dialect (backend plan §4.3). */
export interface DialectMigration {
  name: string;
  // Kysely docs: migrations take Kysely<any>, never the app's DB type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up(db: Kysely<any>, ctx: MigrationContext): Promise<void>;
  /** Dev only: production is forward-only. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  down(db: Kysely<any>, ctx: MigrationContext): Promise<void>;
}

/** Drops tables in the given order (reverse of creation). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dropTables(db: Kysely<any>, tables: readonly string[]): Promise<void> {
  for (const t of tables) await db.schema.dropTable(t).ifExists().execute();
}
