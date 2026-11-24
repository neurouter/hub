import { columnTypes, inList, isBool } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Platform tables: settings, redaction rules, job leases, coordination signals, jobs (§4.2 Platform). */
export const m0009_coordination: DialectMigration = {
  name: '0009_coordination',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);

    await db.schema
      .createTable('settings')
      .addColumn('key', T.text, (c) => c.primaryKey())
      .addColumn('value', T.json, (c) => c.notNull())
      .addColumn('updated_by', T.id)
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('redaction_rules')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('name', T.text, (c) => c.notNull())
      .addColumn('type', T.text, (c) => c.notNull().check(inList('type', ['key', 'regex'])))
      .addColumn('pattern', T.text, (c) => c.notNull())
      .addColumn('replacement', T.text, (c) => c.notNull())
      .addColumn('enabled', T.bool, (c) => c.notNull().defaultTo(1).check(isBool('enabled')))
      .addColumn('order', T.int, (c) => c.notNull())
      .addColumn('builtin', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('builtin')))
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_redaction_rules_order').on('redaction_rules').column('order').execute();

    await db.schema
      .createTable('leases')
      .addColumn('name', T.text, (c) => c.primaryKey())
      .addColumn('holder', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();

    // Polling fallback for Postgres LISTEN/NOTIFY (§12.1). Created on both dialects for a uniform inventory.
    await db.schema
      .createTable('coord_signals')
      .addColumn('channel', T.text, (c) => c.notNull())
      .addColumn('payload', T.json, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_coord_signals_channel_created').on('coord_signals').columns(['channel', 'created_at']).execute();

    await db.schema
      .createTable('jobs')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['tool_sync', 'audit_verify', 'key_rotation', 'reindex'])))
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['queued', 'running', 'ok', 'error'])))
      .addColumn('params', T.json)
      .addColumn('progress', T.float)
      .addColumn('result', T.json)
      .addColumn('error', T.text)
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('finished_at', T.ts)
      .execute();
    await db.schema.createIndex('ix_jobs_kind_created').on('jobs').columns(['kind', 'created_at']).execute();
  },
  async down(db) {
    await dropTables(db, ['jobs', 'coord_signals', 'leases', 'redaction_rules', 'settings']);
  },
};
