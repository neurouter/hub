import { columnTypes } from '../../columns.js';
import type { DialectMigration } from '../types.js';

/**
 * Approvals remember which API key made the held call, so approvers can tell keys of one agent
 * apart (nullable: OAuth calls and rows held before this migration have none).
 */
export const m0010_approval_api_key: DialectMigration = {
  name: '0010_approval_api_key',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    await db.schema.alterTable('approvals').addColumn('api_key_id', T.id).execute();
  },
  async down(db) {
    await db.schema.alterTable('approvals').dropColumn('api_key_id').execute();
  },
};
