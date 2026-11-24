import { columnTypes, inList } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Grants, access requests, rate-limit buckets (§4.2 Policy). Approvals are in 0007. */
export const m0003_policy: DialectMigration = {
  name: '0003_policy',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);

    await db.schema
      .createTable('grants')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('subject_type', T.text, (c) => c.notNull().check(inList('subject_type', ['user', 'group', 'agent'])))
      .addColumn('subject_id', T.id, (c) => c.notNull())
      .addColumn('target_type', T.text, (c) => c.notNull().check(inList('target_type', ['server', 'tool'])))
      .addColumn('target_id', T.id, (c) => c.notNull())
      .addColumn('effect', T.text, (c) => c.notNull().check(inList('effect', ['allow', 'deny'])))
      .addColumn('expires_at', T.ts)
      .addColumn('source', T.text, (c) => c.notNull().defaultTo('manual').check(inList('source', ['manual', 'access_request'])))
      .addColumn('access_request_id', T.id)
      // Reserved for Phase 2 argument-level ACL; must be NULL in Phase 1.
      .addColumn('conditions', T.json)
      .addColumn('note', T.text)
      .addColumn('created_by', T.id, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_grants', ['subject_type', 'subject_id', 'target_type', 'target_id', 'effect'])
      .execute();
    await db.schema.createIndex('ix_grants_target').on('grants').columns(['target_type', 'target_id']).execute();
    await db.schema.createIndex('ix_grants_subject').on('grants').columns(['subject_type', 'subject_id']).execute();

    await db.schema
      .createTable('access_requests')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('requester_user_id', T.id, (c) => c.notNull())
      .addColumn('agent_id', T.id)
      .addColumn('target_type', T.text, (c) => c.notNull().check(inList('target_type', ['server', 'tool'])))
      .addColumn('target_id', T.id, (c) => c.notNull())
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('reason', T.text, (c) => c.notNull())
      .addColumn('requested_duration_days', T.int)
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('pending').check(inList('status', ['pending', 'approved', 'denied', 'cancelled'])))
      .addColumn('decided_by', T.id)
      .addColumn('decided_at', T.ts)
      .addColumn('decision_note', T.text)
      .addColumn('grant_id', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_access_requests_status_server').on('access_requests').columns(['status', 'server_id']).execute();
    await db.schema.createIndex('ix_access_requests_requester_created').on('access_requests').columns(['requester_user_id', 'created_at']).execute();

    // Shared token buckets for the Postgres coordination backend (§13). Created on both dialects
    // so the schema inventory is identical; the memory backend never touches it.
    await db.schema
      .createTable('rate_limit_buckets')
      .addColumn('key', T.text, (c) => c.primaryKey())
      .addColumn('tokens', T.float, (c) => c.notNull())
      .addColumn('capacity', T.float, (c) => c.notNull())
      .addColumn('refill_per_ms', T.float, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await dropTables(db, ['rate_limit_buckets', 'access_requests', 'grants']);
  },
};
