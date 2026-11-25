import { columnTypes, inList } from '../../columns.js';
import type { DialectMigration } from '../types.js';

/**
 * Per-server pinning mode: `strict` (changed definitions are blocked until approved, the default
 * and the behaviour before this migration) or `monitor` (changes apply at once and are flagged).
 */
export const m0011_pinning_mode: DialectMigration = {
  name: '0011_pinning_mode',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    await db.schema
      .alterTable('servers')
      .addColumn('pinning_mode', T.text, (c) => c.notNull().defaultTo('strict').check(inList('pinning_mode', ['strict', 'monitor'])))
      .execute();
  },
  async down(db) {
    await db.schema.alterTable('servers').dropColumn('pinning_mode').execute();
  },
};
