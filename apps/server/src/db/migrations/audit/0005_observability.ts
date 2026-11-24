import { columnTypes, inList, jsonDefault } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';
import type { Kysely } from 'kysely';

/** Latency histogram bucket columns h00..h19 (§10.1). */
export const HISTOGRAM_COLUMNS = Array.from({ length: 20 }, (_, i) => `h${String(i).padStart(2, '0')}`);

/** Metric rollups (1m / 1h) and derived MCP sessions (§4.2, §10). Runs against the AUDIT database. */
export const m0005_observability: DialectMigration = {
  name: '0005_observability',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rollup = async (table: string, db: Kysely<any>) => {
      // Dimension columns use '' for "none", so they are text on both dialects (not uuid).
      let t = db.schema
        .createTable(table)
        .addColumn('bucket', T.ts, (c) => c.notNull())
        .addColumn('server_id', T.text, (c) => c.notNull().defaultTo(''))
        .addColumn('tool_id', T.text, (c) => c.notNull().defaultTo(''))
        .addColumn('agent_id', T.text, (c) => c.notNull().defaultTo(''))
        .addColumn('user_id', T.text, (c) => c.notNull().defaultTo(''))
        .addColumn('calls', T.int, (c) => c.notNull().defaultTo(0))
        .addColumn('ok', T.int, (c) => c.notNull().defaultTo(0))
        .addColumn('tool_errors', T.int, (c) => c.notNull().defaultTo(0))
        .addColumn('upstream_errors', T.int, (c) => c.notNull().defaultTo(0))
        .addColumn('timeouts', T.int, (c) => c.notNull().defaultTo(0))
        .addColumn('blocked', T.int, (c) => c.notNull().defaultTo(0))
        .addColumn('approvals', T.int, (c) => c.notNull().defaultTo(0))
        .addColumn('latency_sum_ms', T.bigint, (c) => c.notNull().defaultTo(0))
        .addColumn('latency_max_ms', T.int, (c) => c.notNull().defaultTo(0));
      for (const h of HISTOGRAM_COLUMNS) t = t.addColumn(h, T.int, (c) => c.notNull().defaultTo(0));
      await t.addPrimaryKeyConstraint(`pk_${table}`, ['bucket', 'server_id', 'tool_id', 'agent_id', 'user_id']).execute();
      for (const dim of ['server_id', 'tool_id', 'agent_id', 'user_id'])
        await db.schema.createIndex(`ix_${table}_${dim.replace('_id', '')}_bucket`).on(table).columns([dim, 'bucket']).execute();
    };
    await rollup('metric_rollups_1m', db);
    await rollup('metric_rollups_1h', db);

    await db.schema
      .createTable('mcp_sessions')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('source', T.text, (c) => c.notNull().check(inList('source', ['client', 'trace', 'legacy', 'idle_gap'])))
      .addColumn('external_key', T.text, (c) => c.notNull())
      .addColumn('agent_id', T.id, (c) => c.notNull())
      .addColumn('user_id', T.id, (c) => c.notNull())
      .addColumn('client_name', T.text)
      .addColumn('first_seen_at', T.ts, (c) => c.notNull())
      .addColumn('last_seen_at', T.ts, (c) => c.notNull())
      .addColumn('calls', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('errors', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('blocked', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('servers', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addUniqueConstraint('uq_mcp_sessions_key', ['source', 'external_key', 'agent_id'])
      .execute();
    await db.schema.createIndex('ix_mcp_sessions_agent_last').on('mcp_sessions').columns(['agent_id', 'last_seen_at']).execute();
    await db.schema.createIndex('ix_mcp_sessions_last').on('mcp_sessions').column('last_seen_at').execute();
  },
  async down(db) {
    await dropTables(db, ['mcp_sessions', 'metric_rollups_1h', 'metric_rollups_1m']);
  },
};

