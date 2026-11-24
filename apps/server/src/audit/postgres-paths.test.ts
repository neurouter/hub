import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { AuditDB, MainDB } from '../db/schema.js';
import type { Databases } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { RollupAggregator, upsertCells } from '../observability/rollups.js';
import { recordUsage, usageCells } from '../observability/usage.js';
import { otelEnabled, resourceAttributes } from '../instrumentation.js';
import { RecordingDriver, recordingKysely } from '../test/fakes/recording-dialect.js';
import { createTestDatabases } from '../test/fakes/test-db.js';
import { adminServerEnricher } from './enrich.js';
import { createPartitionSql, droppable, ensurePartitions, partitionName, partitionRange } from './partitions.js';
import { ftsQuery } from './query.js';
import { SqlAuditStore } from './store.js';
import type { AuditEventInput } from './types.js';

const T = Date.UTC(2026, 10, 24, 15, 30);

describe('Postgres paths (compiled SQL, no database)', () => {
  it('writer takes the advisory xact lock and inserts the chained batch', async () => {
    const driver = new RecordingDriver((q) => ({ rows: q.sql.includes('from "audit_log"') || q.sql.includes('from "audit_checkpoints"') || q.sql.includes('from "mcp_sessions"') ? [] : [] }));
    const { db } = recordingKysely<AuditDB>('postgres', driver);
    const store = new SqlAuditStore(db, 'postgres', { flushIntervalMs: 60_000 });
    store.record({ id: newId(), ts: T, kind: 'tool_call', decision: 'allowed', status: 'ok', agentId: 'a', userId: 'u', sessionKey: { source: 'trace', externalKey: 'f'.repeat(32) } });
    await store.flush();
    const sql = driver.sql();
    expect(sql[0]).toMatch(/select pg_advisory_xact_lock\('\d+'::bigint\)/);
    expect(sql.some((s) => s.startsWith('insert into "audit_log"'))).toBe(true);
    expect(sql.some((s) => s.includes('audit_fts'))).toBe(false);
    expect(store.stats().lastError).toBeNull();
  });

  it('full-text uses to_tsquery(simple) over params_tsv with sanitized lexemes', async () => {
    const driver = new RecordingDriver();
    const { db } = recordingKysely<AuditDB>('postgres', driver);
    await new SqlAuditStore(db, 'postgres').query({ from: 0, to: 1, limit: 5, q: "quarterly 're:port" });
    expect(driver.sql()[0]).toContain("audit_log.params_tsv @@ to_tsquery('simple', $3)");
    expect(driver.queries[0]!.parameters).toContain("'quarterly' & 're' & 'port':*");
    expect(ftsQuery('a b', 'sqlite')).toBe('"a" "b"*');
    expect(ftsQuery('!!!', 'sqlite')).toBeNull();
  });

  it('rollup upserts use greatest() for the max column', async () => {
    const driver = new RecordingDriver();
    const { db } = recordingKysely<AuditDB>('postgres', driver);
    await upsertCells(db, 'postgres', 'metric_rollups_1m', [{ bucket: 0, server_id: 's', tool_id: 't', agent_id: 'a', user_id: 'u', calls: 1, ok: 1, tool_errors: 0, upstream_errors: 0, timeouts: 0, blocked: 0, approvals: 0, latency_sum_ms: 5, latency_max_ms: 5, hist: new Array(20).fill(0) }], 'add');
    expect(driver.sql()[0]).toContain('greatest("metric_rollups_1m".latency_max_ms, excluded.latency_max_ms)');
    expect(driver.sql()[0]).toContain('"calls" = "metric_rollups_1m"."calls" + excluded."calls"');
  });

  it('daily partitions: names, ranges, DDL, creation and droppable selection', async () => {
    expect(partitionName(T)).toBe('audit_log_p20261124');
    expect(partitionRange('audit_log_p20261124')).toEqual({ start: Date.UTC(2026, 10, 24), end: Date.UTC(2026, 10, 25) });
    expect(partitionRange('audit_log_default')).toBeNull();
    expect(createPartitionSql(T)).toBe(`create table if not exists audit_log_p20261124 partition of audit_log for values from (${Date.UTC(2026, 10, 24)}) to (${Date.UTC(2026, 10, 25)})`);
    expect(droppable(['audit_log_p20261101', 'audit_log_p20261124', 'audit_log_default'], Date.UTC(2026, 10, 24))).toEqual(['audit_log_p20261101']);
    const driver = new RecordingDriver((q) => ({ rows: q.sql.includes('pg_inherits') ? [{ name: 'audit_log_p20261124' }] : [] }));
    const { db } = recordingKysely<AuditDB>('postgres', driver);
    const out = await ensurePartitions(db, T, 2);
    expect(out.created).toEqual(['audit_log_p20261125', 'audit_log_p20261126']);
  });
});

describe('SQLite-side helpers', () => {
  let dbs: Databases;
  beforeEach(async () => {
    dbs = await createTestDatabases();
  });
  afterEach(async () => dbs.close());

  it('records tool usage stats with a decayed score (favorites, P2)', async () => {
    const rows = [
      { kind: 'tool_call' as const, tool_id: 't1', agent_id: 'a1', user_id: 'u1', status: 'ok' as const, ts: T },
      { kind: 'tool_call' as const, tool_id: 't1', agent_id: 'a1', user_id: 'u1', status: 'tool_error' as const, ts: T + 1 },
      { kind: 'tool_call' as const, tool_id: 't1', agent_id: 'a1', user_id: 'u1', status: 'blocked' as const, ts: T + 2 },
      { kind: 'tool_search' as const, tool_id: null, agent_id: 'a1', user_id: 'u1', status: 'ok' as const, ts: T },
    ];
    expect(usageCells(rows)).toHaveLength(2);
    await recordUsage(dbs.main.db, rows);
    await recordUsage(dbs.main.db, [{ ...rows[0]!, ts: T + 7 * 86_400_000 }]);
    const agent = await dbs.main.db.selectFrom('tool_usage_stats').selectAll().where('subject_type', '=', 'agent').executeTakeFirstOrThrow();
    expect(agent).toMatchObject({ calls: 3, successes: 2, last_used_at: T + 7 * 86_400_000 });
    expect(agent.decayed).toBeCloseTo(2 * 0.5 + 1, 2); // one half-life later
  });

  it('fills server_id on admin events about tools, access requests and grants', async () => {
    const db: Kysely<MainDB> = dbs.main.db;
    const now = Date.now();
    const uid = newId();
    const sid = newId();
    const tid = newId();
    await db.insertInto('users').values({ id: uid, email: 'o@x', name: 'o', oidc_issuer: null, oidc_subject: null, avatar_url: null, last_login_at: null, created_at: now, updated_at: now }).execute();
    await db.insertInto('servers').values({ id: sid, slug: 's', name: 'S', owner_user_id: uid, description: '', url: 'http://s', transport: 'streamable_http', auth_mode: 'none', trusted: 0, enabled: 1, tags: '[]', icon_url: null, timeout_ms: 1000, sync_interval_min: null, auto_approve_new_tools: 0, oauth_config: null, rate_limit: null, detected_era: null, protocol_version: null, server_info: null, capabilities: null, status: 'active', last_synced_at: null, created_by: uid, created_at: now, updated_at: now } as never).execute();
    await db.insertInto('tools').values({ id: tid, server_id: sid, seq: 1, upstream_name: 'x', exposed_name: 's__x', title: null, description: '', input_schema: '{}', output_schema: null, annotations: null, icons: null, execution: null, pinned_hash: null, pending_hash: null, pending_definition: null, status: 'active', enabled: 1, requires_approval: 0, approval_timeout_sec: null, rate_limit: null, search_text: '', first_seen_at: now, last_seen_at: now, approved_by: null, approved_at: null, created_at: now, updated_at: now } as never).execute();
    const evs: AuditEventInput[] = [
      { id: '1', ts: now, kind: 'admin', decision: 'not_applicable', status: 'ok', targetType: 'tool', targetId: tid },
      { id: '2', ts: now, kind: 'admin', decision: 'not_applicable', status: 'ok', targetType: 'grant', targetId: 'g', changes: { before: null, after: { target: { server: { id: sid } } } } },
      { id: '3', ts: now, kind: 'admin', decision: 'not_applicable', status: 'ok', targetType: 'user', targetId: uid },
    ];
    await adminServerEnricher(db)(evs);
    expect(evs.map((e) => e.serverId ?? null)).toEqual([sid, sid, null]);
  });

  it('aggregator re-adds cells when a flush fails', async () => {
    const agg = new RollupAggregator(dbs.audit.db, 'sqlite');
    agg.add([{ ts: T, kind: 'tool_call', server_id: 's', tool_id: 't', agent_id: 'a', user_id: 'u', decision: 'allowed', status: 'ok', latency_ms: 1 }]);
    const orig = dbs.audit.db.insertInto.bind(dbs.audit.db);
    (dbs.audit.db as unknown as { insertInto: unknown }).insertInto = () => {
      throw new Error('db down');
    };
    await expect(agg.flush()).rejects.toThrow('db down');
    expect(agg.size).toBe(1);
    (dbs.audit.db as unknown as { insertInto: unknown }).insertInto = orig;
    expect(await agg.flush()).toBe(1);
  });
});

describe('OTel bootstrap helpers', () => {
  it('is opt-in and adds service.instance.id', () => {
    expect(otelEnabled({})).toBe(false);
    expect(otelEnabled({ OTEL_SDK_DISABLED: 'false' })).toBe(true);
    expect(resourceAttributes({ INSTANCE_ID: 'pod-1' })).toBe('service.instance.id=pod-1');
    expect(resourceAttributes({ OTEL_RESOURCE_ATTRIBUTES: 'a=b', INSTANCE_ID: 'x' })).toBe('a=b,service.instance.id=x');
    expect(resourceAttributes({ OTEL_RESOURCE_ATTRIBUTES: 'service.instance.id=keep' })).toBe('service.instance.id=keep');
  });
});
