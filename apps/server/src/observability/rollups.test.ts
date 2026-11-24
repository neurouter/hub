import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameResolver } from '../audit/names.js';
import { SqlAuditStore } from '../audit/store.js';
import type { Databases } from '../db/index.js';
import { bucketWidthAt } from '../lib/histogram.js';
import { createTestDatabases } from '../test/fakes/test-db.js';
import { classify, compactHours, HOUR_MS, pruneRollups, RollupAggregator } from './rollups.js';
import { derive, effectiveInterval, plan, RollupQueries } from './rollup-queries.js';

const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);
let dbs: Databases;
beforeEach(async () => {
  dbs = await createTestDatabases();
});
afterEach(async () => dbs.close());

type R = { ts: number; kind: 'tool_call'; server_id: string; tool_id: string; agent_id: string; user_id: string; decision: 'allowed' | 'approved' | 'denied_acl'; status: 'ok' | 'tool_error' | 'upstream_error' | 'timeout' | 'blocked'; latency_ms: number | null };
const row = (o: Partial<R>): R => ({ ts: T0, kind: 'tool_call', server_id: 's1', tool_id: 't1', agent_id: 'a1', user_id: 'u1', decision: 'allowed', status: 'ok', latency_ms: 100, ...o });

/** Seeded dataset: expected values are computed by hand in the assertions. */
function dataset(): R[] {
  const rows: R[] = [];
  for (let i = 0; i < 80; i++) rows.push(row({ ts: T0 + i * 1000, latency_ms: 10 + i })); // s1/t1 ok, 10..89 ms
  for (let i = 0; i < 10; i++) rows.push(row({ ts: T0 + 70_000 + i, status: 'tool_error', latency_ms: 500 }));
  for (let i = 0; i < 5; i++) rows.push(row({ ts: T0 + 3_600_000 + i, server_id: 's2', tool_id: 't2', agent_id: 'a2', user_id: 'u2', status: 'timeout', latency_ms: 30_000 }));
  for (let i = 0; i < 5; i++) rows.push(row({ ts: T0 + 3_600_000 + i, server_id: 's2', tool_id: 't2', decision: 'denied_acl', status: 'blocked', latency_ms: 1 }));
  return rows;
}

describe('rollup aggregator', () => {
  it('classifies calls (§10.1 derived metrics)', () => {
    expect(classify({ decision: 'approved', status: 'ok' })).toEqual({ calls: 1, ok: 1, approvals: 1 });
    expect(classify({ decision: 'denied_acl', status: 'blocked' })).toEqual({ calls: 1, blocked: 1 });
    expect(classify({ decision: 'allowed', status: 'invalid_args' })).toEqual({ calls: 1, tool_errors: 1 });
    expect(derive({ calls: 10, ok: 6, tool_errors: 1, upstream_errors: 1, timeouts: 0, blocked: 2, latency_max_ms: 0, hist: new Array(20).fill(0) })).toMatchObject({ successRate: 0.75, errorRate: 0.25, blocked: 2 });
  });

  it('upserts increments additively (two flushes / two replicas sum)', async () => {
    const a = new RollupAggregator(dbs.audit.db, 'sqlite');
    const b = new RollupAggregator(dbs.audit.db, 'sqlite');
    a.add([row({}), row({ status: 'tool_error', latency_ms: 2000 }), { ...row({}), kind: 'tools_list' } as never]);
    b.add([row({ latency_ms: 3 })]);
    expect(await a.flush()).toBe(1);
    await b.flush();
    a.add([row({ decision: 'approved' })]);
    await a.flush();
    const cell = await dbs.audit.db.selectFrom('metric_rollups_1m').selectAll().executeTakeFirstOrThrow();
    expect(cell).toMatchObject({ bucket: T0, calls: 4, ok: 3, tool_errors: 1, approvals: 1, latency_sum_ms: 2203, latency_max_ms: 2000, h00: 1, h05: 2, h12: 1 });
    expect(await a.flush()).toBe(0);
  });

  it('1h compaction equals the sum of 1m, is idempotent, and retention prunes', async () => {
    const a = new RollupAggregator(dbs.audit.db, 'sqlite');
    a.add(dataset());
    await a.flush();
    const now = T0 + 3 * HOUR_MS;
    expect(await compactHours(dbs.audit.db, 'sqlite', now)).toBeGreaterThan(0);
    await compactHours(dbs.audit.db, 'sqlite', now);
    const sum = async (t: 'metric_rollups_1m' | 'metric_rollups_1h') => dbs.audit.db.selectFrom(t).select((eb) => [eb.fn.sum<number>('calls').as('c'), eb.fn.sum<number>('blocked').as('b'), eb.fn.sum<number>('h19').as('h')]).executeTakeFirstOrThrow();
    expect(await sum('metric_rollups_1h')).toEqual(await sum('metric_rollups_1m'));
    expect(Number((await sum('metric_rollups_1h')).c)).toBe(100);
    expect(await pruneRollups(dbs.audit.db, T0 + 15 * 86_400_000, { minuteDays: 14, hourDays: 400 })).toMatchObject({ hour: 0 });
    expect((await dbs.audit.db.selectFrom('metric_rollups_1m').selectAll().execute()).length).toBe(0);
  });
});

describe('rollup queries', () => {
  async function seeded(now: number) {
    const a = new RollupAggregator(dbs.audit.db, 'sqlite');
    a.add(dataset());
    await a.flush();
    await compactHours(dbs.audit.db, 'sqlite', now);
    const store = new SqlAuditStore(dbs.audit.db, 'sqlite');
    return new RollupQueries(dbs.audit.db, new NameResolver(dbs.main.db), store, () => now);
  }

  it('plans 1m for short ranges and 1h + recent 1m for long ones', () => {
    const now = T0 + 10 * HOUR_MS;
    expect(plan(T0, T0 + HOUR_MS, now, 60_000)).toEqual([{ table: 'metric_rollups_1m', from: T0, to: T0 + HOUR_MS }]);
    const p = plan(T0 - 5 * 86_400_000, now, now, 60_000);
    expect(p.map((x) => x.table)).toEqual(['metric_rollups_1h', 'metric_rollups_1m']);
    expect(p[0]!.to).toBe(p[1]!.from);
    expect(effectiveInterval('1m', 0, 30 * 86_400_000)).toBe('1h');
    expect(effectiveInterval('5m', 0, 86_400_000)).toBe('5m');
  });

  it('summary: totals, rates, percentiles (within one bucket) and the previous window', async () => {
    const q = await seeded(T0 + 2 * HOUR_MS + 1);
    const s = await q.summary({ from: T0, to: T0 + 2 * HOUR_MS });
    expect(s).toMatchObject({ calls: 100, blocked: 5 });
    // ran = 95; ok 80; errors = 10 tool + 5 timeouts
    expect(s.successRate).toBeCloseTo(80 / 95, 6);
    expect(s.errorRate).toBeCloseTo(15 / 95, 6);
    // exact p50 of the 95 latencies (blocked excluded) is 57 ms
    expect(Math.abs(s.latency.p50! - 57)).toBeLessThanOrEqual(bucketWidthAt(57));
    expect(s.latency.p99).toBeGreaterThan(10_000);
    expect(s.previous).toMatchObject({ calls: 0, successRate: null, errorRate: null, blocked: 0 });
    // filters apply on every dimension
    expect((await q.summary({ from: T0, to: T0 + 2 * HOUR_MS, serverIds: ['s2'] })).calls).toBe(10);
    expect((await q.summary({ from: T0, to: T0 + 2 * HOUR_MS, serverIds: [] })).calls).toBe(0);
    expect((await q.summary({ from: T0, to: T0 + 2 * HOUR_MS, userId: 'u2' })).calls).toBe(5);
    // a long range reads 1h + 1m and still matches
    expect((await q.summary({ from: T0 - 5 * 86_400_000, to: T0 + 2 * HOUR_MS })).calls).toBe(100);
  });

  it('timeseries: zero-filled points per interval', async () => {
    const q = await seeded(T0 + 2 * HOUR_MS + 1);
    const ts = await q.timeseries({ from: T0, to: T0 + 2 * HOUR_MS }, '1h');
    expect(ts.interval).toBe('1h');
    expect(ts.points.map((p) => [p.calls, p.success, p.errors, p.blocked])).toEqual([[90, 80, 10, 0], [10, 0, 5, 5]]);
    const fine = await q.timeseries({ from: T0, to: T0 + 5 * 60_000 }, '1m');
    expect(fine.points).toHaveLength(5);
    expect(fine.points.map((p) => p.calls)).toEqual([60, 30, 0, 0, 0]);
  });

  it('breakdown by dimension with sort and limit; block_reason from audit decisions', async () => {
    const q = await seeded(T0 + 2 * HOUR_MS + 1);
    const b = await q.breakdown({ from: T0, to: T0 + 2 * HOUR_MS }, 'server', 'calls', 10);
    expect(b.rows.map((r) => [r.key, r.calls, r.blocked])).toEqual([['s1', 90, 0], ['s2', 10, 5]]);
    expect(b.rows[0]!.label).toBe('(deleted)');
    const byErr = await q.breakdown({ from: T0, to: T0 + 2 * HOUR_MS }, 'agent', 'errorRate', 1);
    expect(byErr.rows.map((r) => r.key)).toEqual(['a2']);
    const reasons = await q.breakdown({ from: T0, to: T0 + 2 * HOUR_MS }, 'block_reason');
    expect(reasons.rows).toEqual([]); // no audit rows seeded in this test
  });
});
