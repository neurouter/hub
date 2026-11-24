import { sql, type Kysely } from 'kysely';
import type { RateLimitStore } from '../../coordination/types.js';
import type { MainDB } from '../../db/schema.js';
import type { Clock } from '../../lib/clock.js';
import { refill, take, type BucketConfig, type BucketState } from './token-bucket.js';

type TakeOpts = { capacity: number; refillPerMs: number; cost?: number };

/** Exact, in-process buckets (SQLite / single replica). */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState & BucketConfig>();

  constructor(private readonly clock: Clock) {}

  async take(key: string, opts: TakeOpts): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const now = this.clock.now();
    const cfg = { capacity: opts.capacity, refillPerMs: opts.refillPerMs };
    const cur = this.buckets.get(key);
    const state = cur && cur.capacity === cfg.capacity && cur.refillPerMs === cfg.refillPerMs ? refill(cur, now, cfg) : { tokens: cfg.capacity, updatedAt: now };
    const r = take(state, opts.cost ?? 1, cfg);
    this.buckets.set(key, { ...r.state, ...cfg });
    if (this.buckets.size > 100_000) this.buckets.delete(this.buckets.keys().next().value!);
    return { allowed: r.ok, retryAfterMs: r.retryAfterMs };
  }

  reset(): void {
    this.buckets.clear();
  }
}

/** The shared-bucket statement the lease store needs (Postgres in prod; fakes in tests). */
export interface BucketExecutor {
  /** Atomically leases `n` tokens from the shared bucket; returns remaining tokens or null when unavailable. */
  lease(key: string, cfg: BucketConfig, n: number, now: number): Promise<number | null>;
  /** Current refilled token count (for retry-after). */
  peek(key: string, cfg: BucketConfig, now: number): Promise<number>;
}

/** backend §13 SQL: refill + conditional decrement in one upsert. */
export class PgBucketExecutor implements BucketExecutor {
  constructor(private readonly db: Kysely<MainDB>) {}

  async lease(key: string, cfg: BucketConfig, n: number, now: number): Promise<number | null> {
    const refilled = sql`least(rate_limit_buckets.capacity, rate_limit_buckets.tokens + (${now} - rate_limit_buckets.updated_at) * rate_limit_buckets.refill_per_ms)`;
    const r = await sql<{ tokens: number }>`
      insert into rate_limit_buckets (key, tokens, capacity, refill_per_ms, updated_at)
      values (${key}, ${cfg.capacity - n}, ${cfg.capacity}, ${cfg.refillPerMs}, ${now})
      on conflict (key) do update set
        tokens = ${refilled} - ${n},
        capacity = excluded.capacity,
        refill_per_ms = excluded.refill_per_ms,
        updated_at = ${now}
      where ${refilled} >= ${n}
      returning tokens`.execute(this.db);
    return r.rows[0] ? Number(r.rows[0].tokens) : null;
  }

  async peek(key: string, cfg: BucketConfig, now: number): Promise<number> {
    const r = await this.db.selectFrom('rate_limit_buckets').select(['tokens', 'updated_at']).where('key', '=', key).executeTakeFirst();
    if (!r) return cfg.capacity;
    return refill({ tokens: Number(r.tokens), updatedAt: Number(r.updated_at) }, now, cfg).tokens;
  }
}

/**
 * Lease-based local tokens (backend §13): each replica leases L = max(1, ceil(capacity·0.1))
 * tokens at a time from the shared bucket, so there is ~1 DB write per L calls per key.
 * Unused leased tokens expire after 2 s (never refunded), bounding overshoot to ≈ replicas × L.
 */
export class LeaseRateLimitStore implements RateLimitStore {
  private readonly local = new Map<string, { tokens: number; expiresAt: number }>();

  constructor(
    private readonly exec: BucketExecutor,
    private readonly clock: Clock,
    private readonly leaseTtlMs = 2000,
  ) {}

  static leaseSize(capacity: number): number {
    return Math.max(1, Math.ceil(capacity * 0.1));
  }

  async take(key: string, opts: TakeOpts): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const cost = opts.cost ?? 1;
    const now = this.clock.now();
    const cfg = { capacity: opts.capacity, refillPerMs: opts.refillPerMs };
    const l = this.local.get(key);
    if (l && l.expiresAt > now && l.tokens >= cost) {
      l.tokens -= cost;
      return { allowed: true, retryAfterMs: 0 };
    }
    const size = Math.max(cost, LeaseRateLimitStore.leaseSize(cfg.capacity));
    for (const n of size > cost ? [size, cost] : [cost]) {
      if ((await this.exec.lease(key, cfg, n, now)) !== null) {
        this.local.set(key, { tokens: n - cost, expiresAt: now + this.leaseTtlMs });
        return { allowed: true, retryAfterMs: 0 };
      }
    }
    this.local.delete(key);
    const available = await this.exec.peek(key, cfg, now);
    return { allowed: false, retryAfterMs: cfg.refillPerMs > 0 ? Math.max(1, Math.ceil((cost - available) / cfg.refillPerMs)) : Number.POSITIVE_INFINITY };
  }

  /** `ratelimit.changed`: drop local leases. */
  reset(): void {
    this.local.clear();
  }
}
