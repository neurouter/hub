import { columnTypes } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Cached icons of library entries (registry icon, site favicon or GitHub avatar), served same-origin. */
export const m0014_library_icons: DialectMigration = {
  name: '0014_library_icons',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    await db.schema
      .createTable('library_icons')
      .addColumn('entry_id', T.id, (c) => c.primaryKey().references('library_entries.id').onDelete('cascade'))
      .addColumn('source_url', T.text)
      .addColumn('content_type', T.text)
      .addColumn('bytes', T.blob)
      .addColumn('etag', T.text)
      .addColumn('fetched_at', T.ts, (c) => c.notNull())
      .addColumn('error', T.text)
      .execute();
  },
  async down(db) {
    await dropTables(db, ['library_icons']);
  },
};
