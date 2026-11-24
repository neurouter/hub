import { columnTypes, inList } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Human approvals of held tool calls (§4.2 Policy, §12.2). */
export const m0007_approvals: DialectMigration = {
  name: '0007_approvals',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    await db.schema
      .createTable('approvals')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tool_id', T.id, (c) => c.notNull())
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('agent_id', T.id, (c) => c.notNull())
      .addColumn('user_id', T.id, (c) => c.notNull())
      .addColumn('audit_request_id', T.id, (c) => c.notNull())
      .addColumn('arguments_redacted', T.json, (c) => c.notNull())
      .addColumn('arguments_hash', T.text, (c) => c.notNull())
      .addColumn('status', T.text, (c) =>
        c.notNull().defaultTo('pending').check(inList('status', ['pending', 'approved', 'denied', 'expired', 'cancelled', 'abandoned'])),
      )
      .addColumn('held_by_instance', T.text, (c) => c.notNull())
      .addColumn('heartbeat_at', T.ts, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .addColumn('decided_by', T.id)
      .addColumn('decided_at', T.ts)
      .addColumn('reason', T.text)
      .addColumn('client_name', T.text)
      .addColumn('client_version', T.text)
      // Additive (frontend addendum #5): the UI shows "<agent> · API key" for API-key calls.
      .addColumn('auth_method', T.text, (c) => c.notNull().defaultTo('api_key').check(inList('auth_method', ['api_key', 'oauth'])))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_approvals_status_server').on('approvals').columns(['status', 'server_id']).execute();
    await db.schema.createIndex('ix_approvals_status_expires').on('approvals').columns(['status', 'expires_at']).execute();
    await db.schema.createIndex('ix_approvals_agent_created').on('approvals').columns(['agent_id', 'created_at']).execute();
    await db.schema.createIndex('ix_approvals_updated').on('approvals').column('updated_at').execute();
  },
  async down(db) {
    await dropTables(db, ['approvals']);
  },
};
