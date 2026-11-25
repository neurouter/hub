import { sql } from 'kysely';
import { columnTypes, inList, isBool, jsonDefault } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/**
 * MCP server library: entries synced from an MCP registry (the official one by default), their
 * last on-demand check and their computed grade, plus the sync state. Entries are third-party
 * metadata, kept apart from `servers` (which hold secrets, grants and pinning).
 */
export const m0012_library: DialectMigration = {
  name: '0012_library',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    const pg = dialect === 'postgres';

    let entries = db.schema
      .createTable('library_entries')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('name', T.text, (c) => c.notNull().unique())
      .addColumn('version', T.text, (c) => c.notNull())
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['active', 'deprecated', 'deleted'])))
      .addColumn('status_message', T.text)
      .addColumn('title', T.text)
      .addColumn('description', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('namespace', T.text, (c) => c.notNull())
      .addColumn('website_url', T.text)
      .addColumn('repository_url', T.text)
      .addColumn('remotes', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('packages', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('has_remote', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('has_remote')))
      .addColumn('has_packages', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('has_packages')))
      .addColumn('has_icons', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('has_icons')))
      .addColumn('remote_url', T.text)
      .addColumn('transport', T.text, (c) => c.check(inList('transport', ['streamable_http', 'sse'])))
      .addColumn('server_json', T.json, (c) => c.notNull())
      .addColumn('published_at', T.ts)
      .addColumn('registry_updated_at', T.ts)
      .addColumn('seen_at', T.ts, (c) => c.notNull())
      .addColumn('hidden', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('hidden')))
      .addColumn('imported_server_id', T.id)
      .addColumn('check_result', T.json)
      .addColumn('checked_at', T.ts)
      .addColumn('grade', T.text, (c) => c.check(inList('grade', ['A', 'B', 'C', 'D', 'F'])))
      .addColumn('grade_score', T.float)
      .addColumn('confidence', T.text, (c) => c.notNull().defaultTo('low').check(inList('confidence', ['low', 'medium', 'high'])))
      .addColumn('trust', T.text, (c) => c.notNull().defaultTo('unverified').check(inList('trust', ['verified', 'known', 'unverified', 'mismatch'])))
      .addColumn('top_flag', T.json)
      .addColumn('graded_at', T.ts)
      .addColumn('search_text', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull());
    if (pg) {
      entries = entries.addColumn('search_tsv', sql`tsvector`, (c) =>
        c
          .generatedAlwaysAs(
            sql`setweight(to_tsvector('simple'::regconfig, coalesce(name, '') || ' ' || coalesce(title, '')), 'A') || setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'B') || setweight(to_tsvector('simple'::regconfig, coalesce(search_text, '')), 'C')`,
          )
          .stored(),
      );
    }
    await entries.execute();
    await db.schema.createIndex('ix_library_entries_status_remote').on('library_entries').columns(['status', 'has_remote']).execute();
    await db.schema.createIndex('ix_library_entries_namespace').on('library_entries').column('namespace').execute();
    await db.schema.createIndex('ix_library_entries_remote_url').on('library_entries').column('remote_url').execute();
    await db.schema.createIndex('ix_library_entries_grade_score').on('library_entries').column('grade_score').execute();
    if (pg) await sql`create index ix_library_entries_search_tsv on library_entries using gin (search_tsv)`.execute(db);
    else {
      // Keyword index for SQLite, maintained by the sync write path (Postgres uses search_tsv).
      await sql`create virtual table library_fts using fts5(entry_id unindexed, name, title, description, search_text, tokenize='unicode61 remove_diacritics 2')`.execute(db);
    }

    await db.schema
      .createTable('library_sync_state')
      .addColumn('id', T.text, (c) => c.primaryKey())
      .addColumn('running', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('running')))
      .addColumn('mode', T.text, (c) => c.check(inList('mode', ['full', 'incremental'])))
      .addColumn('pages', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('cursor', T.text)
      .addColumn('checkpoint', T.ts)
      .addColumn('run_started_at', T.ts)
      .addColumn('last_run_at', T.ts)
      .addColumn('last_success_at', T.ts)
      .addColumn('last_full_at', T.ts)
      .addColumn('last_error', T.text)
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
  },
  async down(db, { dialect }) {
    if (dialect === 'sqlite') await sql`drop table if exists library_fts`.execute(db);
    await dropTables(db, ['library_sync_state', 'library_entries']);
  },
};
