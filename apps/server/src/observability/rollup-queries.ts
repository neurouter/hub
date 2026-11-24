import { sql, type Kysely, type SelectQueryBuilder, type SqlBool } from 'kysely';
import { isBlockedDecision, type Breakdown, type BreakdownDimension, type MetricsInterval, type MetricsSummary, type Timeseries } from '@neurouter/shared';
import type { AuditStore } from '../audit/store.js';
import { DELETED, type NameResolver } from '../audit/names.js';
import type { AuditDB } from '../db/schema.js';
import { addHistograms, emptyHistogram, HISTOGRAM_KEYS, percentile } from '../lib/histogram.js';
import { HOUR_MS } from './rollups.js';

export const INTERVAL_MS: Record<MetricsInterval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '6h': 21_600_000, '1d': 86_400_000 };
const INTERVALS = Object.keys(INTERVAL_MS) as MetricsInterval[];
export const MAX_POINTS = 1500;
const TWO_DAYS = 2 * 86_400_000;

export interface MetricsFilter {
  from: number;
  to: number;
  serverIds?: readonly string[];
  toolId?: string;
  agentId?: string;
  userId?: string;
}

interface Totals {
  calls: number;
  ok: number;
  tool_errors: number;
  upstream_errors: number;
  timeouts: number;
  blocked: number;
  latency_max_ms: number;
  hist: number[];
}

const zero = (): Totals => ({ calls: 0, ok: 0, tool_errors: 0, upstream_errors: 0, timeouts: 0, blocked: 0, latency_max_ms: 0, hist: emptyHistogram() });

function addTotals(a: Totals, b: Totals): Totals {
  a.calls += b.calls;
  a.ok += b.ok;
  a.tool_errors += b.tool_errors;
  a.upstream_errors += b.upstream_errors;
  a.timeouts += b.timeouts;
  a.blocked += b.blocked;
  a.latency_max_ms = Math.max(a.latency_max_ms, b.latency_max_ms);
  addHistograms(a.hist, b.hist);
  return a;
}

/** success = ok / (calls − blocked); error = (tool + upstream + timeouts) / (calls − blocked) (§10.1). */
export function derive(t: Totals) {
  const ran = t.calls - t.blocked;
  const errors = t.tool_errors + t.upstream_errors + t.timeouts;
  return {
    calls: t.calls,
    successRate: ran > 0 ? Math.min(1, t.ok / ran) : null,
    errorRate: ran > 0 ? Math.min(1, errors / ran) : null,
    blocked: t.blocked,
    errors,
    latency: { p50: percentile(t.hist, 0.5, t.latency_max_ms), p95: percentile(t.hist, 0.95, t.latency_max_ms), p99: percentile(t.hist, 0.99, t.latency_max_ms) },
  };
}

/** Smallest interval ≥ the requested one that keeps the series under MAX_POINTS (effective interval). */
export function effectiveInterval(requested: MetricsInterval, from: number, to: number): MetricsInterval {
  let i = INTERVALS.indexOf(requested);
  while (i < INTERVALS.length - 1 && (to - from) / INTERVAL_MS[INTERVALS[i]!] > MAX_POINTS) i++;
  return INTERVALS[i]!;
}

/**
 * Picks the rollup tables for a range (§10.1: interval ≥ 1h or range > 2 days reads 1h). The 1h
 * table only holds closed, compacted hours, so the most recent hour(s) always come from 1m:
 * split at `hourFloor(now) − 1h`.
 */
export function plan(from: number, to: number, now: number, intervalMs: number): { table: 'metric_rollups_1m' | 'metric_rollups_1h'; from: number; to: number }[] {
  const use1h = intervalMs >= HOUR_MS || to - from > TWO_DAYS;
  if (!use1h) return [{ table: 'metric_rollups_1m', from, to }];
  const split = now - (now % HOUR_MS) - HOUR_MS;
  const parts: { table: 'metric_rollups_1m' | 'metric_rollups_1h'; from: number; to: number }[] = [];
  if (from < split) parts.push({ table: 'metric_rollups_1h', from, to: Math.min(to, split) });
  if (to > split) parts.push({ table: 'metric_rollups_1m', from: Math.max(from, split), to });
  return parts;
}

type DimCol = 'server_id' | 'tool_id' | 'agent_id' | 'user_id';
const DIM_COL: Record<Exclude<BreakdownDimension, 'block_reason'>, DimCol> = { server: 'server_id', tool: 'tool_id', agent: 'agent_id', user: 'user_id' };

/** Dashboard queries over the rollups (§10.2); scope (owner servers / own user) is already applied to the filter. */
export class RollupQueries {
  constructor(
    private readonly db: Kysely<AuditDB>,
    private readonly names: NameResolver,
    private readonly store: AuditStore,
    private readonly now: () => number,
  ) {}

  private where<O>(qb: SelectQueryBuilder<AuditDB, 'metric_rollups_1m' | 'metric_rollups_1h', O>, f: MetricsFilter, range: { from: number; to: number }) {
    let x = qb.where('bucket', '>=', range.from).where('bucket', '<', range.to);
    if (f.serverIds !== undefined) x = f.serverIds.length ? x.where('server_id', 'in', [...f.serverIds]) : x.where(sql<SqlBool>`1 = 0`);
    if (f.toolId) x = x.where('tool_id', '=', f.toolId);
    if (f.agentId) x = x.where('agent_id', '=', f.agentId);
    if (f.userId) x = x.where('user_id', '=', f.userId);
    return x;
  }

  private sums() {
    return [
      sql<number>`sum(calls)`.as('calls'),
      sql<number>`sum(ok)`.as('ok'),
      sql<number>`sum(tool_errors)`.as('tool_errors'),
      sql<number>`sum(upstream_errors)`.as('upstream_errors'),
      sql<number>`sum(timeouts)`.as('timeouts'),
      sql<number>`sum(blocked)`.as('blocked'),
      sql<number>`max(latency_max_ms)`.as('latency_max_ms'),
      ...HISTOGRAM_KEYS.map((h) => sql<number>`sum(${sql.ref(h)})`.as(h)),
    ];
  }

  private toTotals(r: Record<string, unknown>): Totals {
    return {
      calls: Number(r.calls ?? 0),
      ok: Number(r.ok ?? 0),
      tool_errors: Number(r.tool_errors ?? 0),
      upstream_errors: Number(r.upstream_errors ?? 0),
      timeouts: Number(r.timeouts ?? 0),
      blocked: Number(r.blocked ?? 0),
      latency_max_ms: Number(r.latency_max_ms ?? 0),
      hist: HISTOGRAM_KEYS.map((h) => Number(r[h] ?? 0)),
    };
  }

  async totals(f: MetricsFilter, intervalMs = 60_000): Promise<Totals> {
    const out = zero();
    for (const p of plan(f.from, f.to, this.now(), intervalMs)) {
      const r = await this.where(this.db.selectFrom(p.table).select(this.sums()), f, p).executeTakeFirst();
      if (r) addTotals(out, this.toTotals(r as Record<string, unknown>));
    }
    return out;
  }

  async summary(f: MetricsFilter): Promise<MetricsSummary> {
    const len = f.to - f.from;
    const [cur, prev] = await Promise.all([this.totals(f), this.totals({ ...f, from: f.from - len, to: f.from })]);
    const c = derive(cur);
    const p = derive(prev);
    const core = (d: ReturnType<typeof derive>) => ({ calls: d.calls, successRate: d.successRate, errorRate: d.errorRate, blocked: d.blocked, latency: d.latency });
    return { ...core(c), previous: core(p) };
  }

  async timeseries(f: MetricsFilter, requested: MetricsInterval): Promise<Timeseries> {
    const interval = effectiveInterval(requested, f.from, f.to);
    const step = INTERVAL_MS[interval];
    const buckets = new Map<number, Totals>();
    for (const p of plan(f.from, f.to, this.now(), step)) {
      // literal (not a bind param): Postgres must see the same expression in SELECT and GROUP BY
      const tb = sql<number>`(bucket - (bucket % ${sql.lit(step)}))`;
      const rows = await this.where(this.db.selectFrom(p.table).select([tb.as('tb'), ...this.sums()]), f, p)
        .groupBy(tb)
        .execute();
      for (const r of rows) {
        const t = Number((r as { tb: number }).tb);
        buckets.set(t, addTotals(buckets.get(t) ?? zero(), this.toTotals(r as Record<string, unknown>)));
      }
    }
    const points: Timeseries['points'] = [];
    for (let t = f.from - (f.from % step); t < f.to; t += step) {
      const tot = buckets.get(t) ?? zero();
      const d = derive(tot);
      points.push({ t: new Date(t).toISOString(), calls: d.calls, success: tot.ok, errors: d.errors, blocked: d.blocked, p50: d.latency.p50, p95: d.latency.p95, p99: d.latency.p99 });
    }
    return { interval, points };
  }

  async breakdown(f: MetricsFilter, dimension: BreakdownDimension, sort: 'calls' | 'errorRate' | 'p95' | 'blocked' = 'calls', limit = 10): Promise<Breakdown> {
    if (dimension === 'block_reason') return this.blockReasons(f, limit);
    const col = DIM_COL[dimension];
    const groups = new Map<string, Totals>();
    for (const p of plan(f.from, f.to, this.now(), 60_000)) {
      const rows = await this.where(this.db.selectFrom(p.table).select([sql.ref(col).as('k'), ...this.sums()]), f, p)
        .groupBy(col)
        .execute();
      for (const r of rows) {
        const k = String((r as { k: string }).k);
        groups.set(k, addTotals(groups.get(k) ?? zero(), this.toTotals(r as Record<string, unknown>)));
      }
    }
    const keys = [...groups.keys()].filter((k) => k !== '');
    const m = await this.names.load({ users: dimension === 'user' ? keys : [], agents: dimension === 'agent' ? keys : [], servers: dimension === 'server' ? keys : [], tools: dimension === 'tool' ? keys : [] });
    const label = (k: string) =>
      dimension === 'server' ? (m.servers.get(k)?.name ?? DELETED) : dimension === 'tool' ? (m.tools.get(k)?.exposedName ?? DELETED) : dimension === 'agent' ? (m.agents.get(k) ?? DELETED) : (m.users.get(k)?.name ?? DELETED);
    const rows = [...groups.entries()].map(([k, t]) => {
      const d = derive(t);
      return { key: k || 'none', label: k ? label(k) : '(none)', calls: d.calls, successRate: d.successRate, errorRate: d.errorRate, p95: d.latency.p95, blocked: d.blocked };
    });
    const val = (r: (typeof rows)[number]) => (sort === 'calls' ? r.calls : sort === 'blocked' ? r.blocked : sort === 'p95' ? (r.p95 ?? -1) : (r.errorRate ?? -1));
    rows.sort((a, b) => val(b) - val(a) || b.calls - a.calls || a.label.localeCompare(b.label));
    return { rows: rows.slice(0, limit) };
  }

  /** `block_reason` comes from audit decisions, not rollups (§14.3). */
  private async blockReasons(f: MetricsFilter, limit: number): Promise<Breakdown> {
    const counts = await this.store.decisionCounts({
      from: f.from,
      to: f.to,
      kinds: ['tool_call'],
      ...(f.serverIds !== undefined ? { serverIds: f.serverIds } : {}),
      ...(f.toolId ? { toolId: f.toolId } : {}),
      ...(f.agentId ? { agentId: f.agentId } : {}),
      ...(f.userId ? { userId: f.userId } : {}),
    });
    const by = new Map<string, number>();
    for (const c of counts) {
      if (!isBlockedDecision(c.decision)) continue;
      by.set(c.decision, (by.get(c.decision) ?? 0) + c.count);
    }
    const LABELS: Record<string, string> = {
      denied_acl: 'Not permitted',
      denied_disabled: 'Disabled',
      denied_rate_limit: 'Rate limited',
      approval_denied: 'Approval denied',
      approval_timeout: 'Approval timed out',
      approval_cancelled: 'Approval cancelled',
    };
    const rows = [...by.entries()]
      .map(([k, n]) => ({ key: k, label: LABELS[k] ?? k, calls: n, successRate: null, errorRate: null, p95: null, blocked: n }))
      .sort((a, b) => b.blocked - a.blocked)
      .slice(0, limit);
    return { rows };
  }
}
