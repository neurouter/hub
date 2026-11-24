import { sql } from 'kysely';
import { columnTypes, inList } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Embeddings, keyword index, usage stats and pins (§4.2 Search and usage, §11). */
export const m0006_search: DialectMigration = {
  name: '0006_search',
  async up(db, { dialect, embeddingDims }) {
    const T = columnTypes(dialect);
    const pg = dialect === 'postgres';

    if (pg) {
      try {
        await sql`create extension if not exists vector`.execute(db);
      } catch (err) {
        throw new Error(
          'Failed to enable the pgvector extension. A database administrator must run `CREATE EXTENSION vector;` ' +
            `in this database (or grant the privilege) before Neurouter can start. Cause: ${(err as Error).message}`,
          { cause: err },
        );
      }
    }

    const dims = Math.trunc(embeddingDims);
    if (!(dims > 0 && dims <= 2000)) throw new Error(`Invalid embedding dimensions: ${embeddingDims}`);

    await db.schema
      .createTable('tool_embeddings')
      .addColumn('tool_id', T.id, (c) => c.primaryKey().references('tools.id').onDelete('cascade'))
      .addColumn('tool_seq', T.bigint, (c) => c.notNull())
      .addColumn('model_id', T.text, (c) => c.notNull())
      .addColumn('dims', T.int, (c) => c.notNull())
      .addColumn('text_hash', T.text, (c) => c.notNull())
      // SQLite: float32 BLOB used with sqlite-vec vec_distance_cosine(); Postgres: pgvector column.
      .addColumn('embedding', pg ? sql.raw(`vector(${dims})`) : T.blob, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_tool_embeddings_seq').on('tool_embeddings').column('tool_seq').execute();

    if (!pg) {
      // External-content FTS5 index over `tools` (rowid = tools.seq). Column names match `tools`
      // so FTS5 can read content back; kept in sync by the repo write path (no triggers).
      await sql`create virtual table tools_fts using fts5(exposed_name, title, description, search_text, content='tools', content_rowid='seq', tokenize='unicode61 remove_diacritics 2')`.execute(db);
    }

    await db.schema
      .createTable('tool_usage_stats')
      .addColumn('subject_type', T.text, (c) => c.notNull().check(inList('subject_type', ['agent', 'user'])))
      .addColumn('subject_id', T.id, (c) => c.notNull())
      .addColumn('tool_id', T.id, (c) => c.notNull())
      .addColumn('calls', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('successes', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('decayed', T.float, (c) => c.notNull().defaultTo(0))
      .addColumn('last_used_at', T.ts)
      .addPrimaryKeyConstraint('pk_tool_usage_stats', ['subject_type', 'subject_id', 'tool_id'])
      .execute();

    await db.schema
      .createTable('tool_pins')
      .addColumn('subject_type', T.text, (c) => c.notNull().check(inList('subject_type', ['agent', 'user'])))
      .addColumn('subject_id', T.id, (c) => c.notNull())
      .addColumn('tool_id', T.id, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_tool_pins', ['subject_type', 'subject_id', 'tool_id'])
      .execute();
  },
  async down(db, { dialect }) {
    if (dialect === 'sqlite') await sql`drop table if exists tools_fts`.execute(db);
    await dropTables(db, ['tool_pins', 'tool_usage_stats', 'tool_embeddings']);
  },
};
