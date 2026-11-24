import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { AuditDB, AuditLogTable } from '../db/schema.js';
import type { Dialect } from '../db/url.js';
import { bucketIndex, emptyHistogram, HISTOGRAM_KEYS, HISTOGRAM_SIZE } from '../lib/histogram.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

export const COUNTER_COLUMNS = ['calls', 'ok', 'tool_errors', 'upstream_errors', 'timeouts', 'blocked', 'approvals', 'latency_sum_ms'] as const;
type CounterCol = (typeof COUNTER_COLUMNS)[number];

export interface RollupAcc {
  bucket: number;
  server_id: string;
  tool_id: string;
  agent_id: string;
  user_id: string;
  calls: number;
  ok: number;
  tool_errors: number;
  upstream_errors: number;
  timeouts: number;
  blocked: number;
  approvals: number;
  latency_sum_ms: number;
  latency_max_ms: number;
  hist: number[];
}

/** How one tool call counts (§10.1 derived metrics). Latency is only sampled for calls that ran. */
export function classify(r: Pick<AuditLogTable, 'decision' | 'status'>): Partial<Record<CounterCol, number>> {
  const out: Partial<Record<CounterCol, number>> = { calls: 1 };
  switch (r.status) {
    case 'ok':
      out.ok = 1;
      break;
    case 'tool_error':
    case 'invalid_args':
      out.tool_errors = 1;
      break;
    case 'upstream_error':
      out.upstream_errors = 1;
      break;
    case 'timeout':
      out.timeouts = 1;
      break;
    case 'blocked':
      out.blocked = 1;
      break;
    default:
      break;
  }
  if (r.decision === 'approved') out.approvals = 1;
  return out;
}

type RollupRow = Pick<AuditLogTable, 'ts' | 'kind' | 'server_id' | 'tool_id' | 'agent_id' | 'user_id' | 'decision' | 'status' | 'latency_ms'>;

/**
 * In-process per-replica aggregator (§10.1). Each committed `tool_call` audit row increments
 * the (minute, server, tool, agent, user) cell; `flush()` upserts with additive conflict updates,
 * so increments from many replicas sum correctly.
 */
export class RollupAggregator {
  private cells = new Map<string, RollupAcc>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly db: Kysely<AuditDB>,
    private readonly dialect: Dialect,
    private readonly log: { warn(o: object, m: string): void } = { warn: () => {} },
  ) {}

  get size(): number {
    return this.cells.size;
  }

  add(rows: readonly RollupRow[]): void {
    for (const r of rows) {
      // the interim "held for approval" row is not a call; the final row of the same request is
      if (r.kind !== 'tool_call' || r.decision === 'approval_pending') continue;
      const bucket = Number(r.ts) - (Number(r.ts) % MINUTE_MS);
      const dims = { server_id: r.server_id ?? '', tool_id: r.tool_id ?? '', agent_id: r.agent_id ?? '', user_id: r.user_id ?? '' };
      const key = `${bucket}|${dims.server_id}|${dims.tool_id}|${dims.agent_id}|${dims.user_id}`;
      let c = this.cells.get(key);
      if (!c) {
        c = { bucket, ...dims, calls: 0, ok: 0, tool_errors: 0, upstream_errors: 0, timeouts: 0, blocked: 0, approvals: 0, latency_sum_ms: 0, latency_max_ms: 0, hist: emptyHistogram() };
        this.cells.set(key, c);
      }
      for (const [k, v] of Object.entries(classify(r)) as [CounterCol, number][]) c[k] += v;
      if (r.latency_ms !== null && r.status !== 'blocked') {
        const l = Math.max(0, Number(r.latency_ms));
        c.latency_sum_ms += l;
        c.latency_max_ms = Math.max(c.latency_max_ms, l);
        c.hist[bucketIndex(l)]!++;
      }
    }
  }

  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush().catch((err: unknown) => this.log.warn({ err }, 'rollup flush failed')), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** Upserts and clears the accumulated cells. A failed flush merges the cells back. */
  async flush(): Promise<number> {
    while (this.flushing) await this.flushing;
    if (!this.cells.size) return 0;
    const cells = [...this.cells.values()];
    this.cells = new Map();
    let n = 0;
    this.flushing = (async () => {
      try {
        for (let i = 0; i < cells.length; i += 25) {
          await upsertCells(this.db, this.dialect, 'metric_rollups_1m', cells.slice(i, i + 25), 'add');
          n += Math.min(25, cells.length - i);
        }
      } catch (err) {
        // put back what wasn't written (additive, so re-adding is safe)
        for (const c of cells.slice(n)) {
          const key = `${c.bucket}|${c.server_id}|${c.tool_id}|${c.agent_id}|${c.user_id}`;
          const cur = this.cells.get(key);
          if (!cur) this.cells.set(key, c);
          else {
            for (const k of COUNTER_COLUMNS) cur[k] += c[k];
            cur.latency_max_ms = Math.max(cur.latency_max_ms, c.latency_max_ms);
            for (let h = 0; h < HISTOGRAM_SIZE; h++) cur.hist[h]! += c.hist[h]!;
          }
        }
        throw err;
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
    return n;
  }
}

const maxFn = (dialect: Dialect, a: RawBuilder<unknown>, b: RawBuilder<unknown>) => (dialect === 'postgres' ? sql`greatest(${a}, ${b})` : sql`max(${a}, ${b})`);

/** `mode: 'add'` sums into existing cells (1m flush); `'replace'` overwrites (idempotent 1h compaction). */
export async function upsertCells(db: Kysely<AuditDB>, dialect: Dialect, table: 'metric_rollups_1m' | 'metric_rollups_1h', cells: readonly RollupAcc[], mode: 'add' | 'replace'): Promise<void> {
  if (!cells.length) return;
  const values = cells.map((c) => {
    const v: Record<string, number | string> = { bucket: c.bucket, server_id: c.server_id, tool_id: c.tool_id, agent_id: c.agent_id, user_id: c.user_id, latency_max_ms: c.latency_max_ms };
    for (const k of COUNTER_COLUMNS) v[k] = c[k];
    HISTOGRAM_KEYS.forEach((h, i) => (v[h] = c.hist[i] ?? 0));
    return v;
  });
  await db
    .insertInto(table)
    .values(values as never)
    .onConflict((oc) =>
      oc.columns(['bucket', 'server_id', 'tool_id', 'agent_id', 'user_id']).doUpdateSet(() => {
        const set: Record<string, unknown> = {};
        const t = sql.ref(table);
        for (const k of [...COUNTER_COLUMNS, ...HISTOGRAM_KEYS]) set[k] = mode === 'add' ? sql`${t}.${sql.ref(k)} + excluded.${sql.ref(k)}` : sql`excluded.${sql.ref(k)}`;
        set.latency_max_ms = mode === 'add' ? maxFn(dialect, sql`${t}.latency_max_ms`, sql`excluded.latency_max_ms`) : sql`excluded.latency_max_ms`;
        return set as never;
      }),
    )
    .execute();
}

/**
 * Hourly compaction (§10.1, leader job at :05): re-aggregates the 1m cells of the last
 * `hours` closed hours into 1h, replacing existing 1h cells (idempotent, catches late flushes).
 */
export async function compactHours(db: Kysely<AuditDB>, dialect: Dialect, now: number, hours = 3): Promise<number> {
  const end = now - (now % HOUR_MS);
  const start = end - hours * HOUR_MS;
  const hb = sql<number>`(bucket - (bucket % ${HOUR_MS}))`;
  const sums = [...COUNTER_COLUMNS, ...HISTOGRAM_KEYS].map((k) => sql<number>`sum(${sql.ref(k)})`.as(k));
  const rows = await db
    .selectFrom('metric_rollups_1m')
    .select([hb.as('hb'), 'server_id', 'tool_id', 'agent_id', 'user_id', sql<number>`max(latency_max_ms)`.as('latency_max_ms'), ...sums])
    .where('bucket', '>=', start)
    .where('bucket', '<', end)
    .groupBy([hb, 'server_id', 'tool_id', 'agent_id', 'user_id'])
    .execute();
  const cells: RollupAcc[] = rows.map((r) => {
    const x = r as unknown as Record<string, number | string>;
    const c = { bucket: Number(x.hb), server_id: String(x.server_id), tool_id: String(x.tool_id), agent_id: String(x.agent_id), user_id: String(x.user_id), latency_max_ms: Number(x.latency_max_ms), hist: HISTOGRAM_KEYS.map((h) => Number(x[h] ?? 0)) } as RollupAcc;
    for (const k of COUNTER_COLUMNS) c[k] = Number(x[k] ?? 0);
    return c;
  });
  for (let i = 0; i < cells.length; i += 25) await upsertCells(db, dialect, 'metric_rollups_1h', cells.slice(i, i + 25), 'replace');
  return cells.length;
}

/** Rollup retention (§10.1): 1m for `minuteDays`, 1h for `hourDays`. */
export async function pruneRollups(db: Kysely<AuditDB>, now: number, retention: { minuteDays: number; hourDays: number }): Promise<{ minute: number; hour: number }> {
  const m = await db.deleteFrom('metric_rollups_1m').where('bucket', '<', now - retention.minuteDays * 86_400_000).executeTakeFirst();
  const h = await db.deleteFrom('metric_rollups_1h').where('bucket', '<', now - retention.hourDays * 86_400_000).executeTakeFirst();
  return { minute: Number(m.numDeletedRows), hour: Number(h.numDeletedRows) };
}
