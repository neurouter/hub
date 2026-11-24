import { sql, type CreateTableBuilder } from 'kysely';
import { AuditDecision, AuditKind, AuditStatus } from '@neurouter/shared';
import { columnTypes, inList } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/**
 * Audit log, checkpoints and sink cursors (§4.2 Audit). Runs against the AUDIT database
 * (AUDIT_DATABASE_URL, defaulting to DATABASE_URL), so it has no FKs into control-plane tables.
 * Postgres: `audit_log` is range-partitioned by `ts` (daily partitions are created by the
 * partition job; a DEFAULT partition catches rows before the job has run).
 */
export const m0004_audit: DialectMigration = {
  name: '0004_audit',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    const pg = dialect === 'postgres';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let audit: CreateTableBuilder<any, any> = db.schema.createTable('audit_log');
    audit = pg
      ? audit.addColumn('seq', T.bigint, (c) => c.notNull())
      : audit.addColumn('seq', 'integer', (c) => c.primaryKey());
    audit = audit
      .addColumn('id', T.id, (c) => c.notNull())
      .addColumn('ts', T.ts, (c) => c.notNull())
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', AuditKind.options)))
      .addColumn('request_id', T.id)
      .addColumn('user_id', T.id)
      .addColumn('agent_id', T.id)
      .addColumn('api_key_id', T.id)
      .addColumn('oauth_client_id', T.id)
      .addColumn('client_name', T.text)
      .addColumn('client_version', T.text)
      .addColumn('protocol_version', T.text)
      .addColumn('client_era', T.text)
      .addColumn('server_id', T.id)
      .addColumn('tool_id', T.id)
      .addColumn('tool_name', T.text)
      .addColumn('action', T.text)
      .addColumn('target_type', T.text)
      .addColumn('target_id', T.text)
      .addColumn('decision', T.text, (c) => c.notNull().check(inList('decision', AuditDecision.options)))
      .addColumn('decision_reason', T.text)
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', AuditStatus.options)))
      .addColumn('params_redacted', T.json)
      .addColumn('params_text', T.text)
      .addColumn('changes', T.json)
      .addColumn('output_size', T.int)
      .addColumn('output_hash', T.text)
      .addColumn('output_full', T.json)
      .addColumn('latency_ms', T.int)
      .addColumn('upstream_latency_ms', T.int)
      .addColumn('error_code', T.text)
      .addColumn('error_message', T.text)
      .addColumn('trace_id', T.text)
      .addColumn('span_id', T.text)
      .addColumn('session_id', T.id)
      .addColumn('ip', T.text)
      .addColumn('user_agent', T.text)
      .addColumn('prev_hash', T.text, (c) => c.notNull())
      .addColumn('hash', T.text, (c) => c.notNull());
    if (pg) {
      // Bounded FTS (approved addendum 4): tool, error, decision reason and allow-listed param values only.
      audit = audit
        .addColumn('params_tsv', sql`tsvector`, (c) =>
          c
            .generatedAlwaysAs(
              sql`to_tsvector('simple'::regconfig, coalesce(tool_name, '') || ' ' || coalesce(error_message, '') || ' ' || coalesce(decision_reason, '') || ' ' || coalesce(params_text, ''))`,
            )
            .stored(),
        )
        .addPrimaryKeyConstraint('pk_audit_log', ['seq', 'ts'])
        .addUniqueConstraint('uq_audit_log_id_ts', ['id', 'ts'])
        .modifyEnd(sql`partition by range (ts)`);
    } else {
      audit = audit.addUniqueConstraint('uq_audit_log_id', ['id']);
    }
    await audit.execute();

    if (pg) await sql`create table audit_log_default partition of audit_log default`.execute(db);

    const ix = (name: string, cols: string[]) => db.schema.createIndex(name).on('audit_log').columns(cols).execute();
    await ix('ix_audit_log_ts', ['ts']);
    await ix('ix_audit_log_user_ts', ['user_id', 'ts']);
    await ix('ix_audit_log_agent_ts', ['agent_id', 'ts']);
    await ix('ix_audit_log_server_ts', ['server_id', 'ts']);
    await ix('ix_audit_log_tool_ts', ['tool_id', 'ts']);
    await ix('ix_audit_log_session_ts', ['session_id', 'ts']);
    await ix('ix_audit_log_trace', ['trace_id']);
    await ix('ix_audit_log_decision_ts', ['decision', 'ts']);
    await ix('ix_audit_log_kind_ts', ['kind', 'ts']);

    if (pg) {
      await sql`create index ix_audit_log_params_tsv on audit_log using gin (params_tsv)`.execute(db);
    } else {
      await sql`create virtual table audit_fts using fts5(params_text, tool_name, error_message, decision_reason, content='audit_log', content_rowid='seq')`.execute(db);
    }

    await db.schema
      .createTable('audit_checkpoints')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('seq', T.bigint, (c) => c.notNull())
      .addColumn('hash', T.text, (c) => c.notNull())
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['periodic', 'retention_cut', 'key_rotation'])))
      .addColumn('mac', T.text, (c) => c.notNull())
      .addColumn('key_id', T.text, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_audit_checkpoints_seq').on('audit_checkpoints').column('seq').execute();

    await db.schema
      .createTable('audit_sink_cursors')
      .addColumn('sink', T.text, (c) => c.primaryKey())
      .addColumn('last_seq', T.bigint, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addColumn('last_error', T.text)
      .execute();
  },
  async down(db, { dialect }) {
    if (dialect === 'sqlite') await sql`drop table if exists audit_fts`.execute(db);
    await dropTables(db, ['audit_sink_cursors', 'audit_checkpoints', 'audit_log']);
  },
};
