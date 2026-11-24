import { describe, expect, it } from 'vitest';
import { recordingKysely } from '../../test/fakes/recording-dialect.js';
import { FakeClock } from '../../test/fakes/context.js';
import type { MainDB } from '../../db/schema.js';
import { LeaseRateLimitStore, MemoryRateLimitStore, PgBucketExecutor, type BucketExecutor } from './stores.js';
import { perMinute, refill, take } from './token-bucket.js';

describe('token bucket', () => {
  it('refills linearly up to capacity and computes retry-after', () => {
    const cfg = perMinute(60, 10); // 1 token/s
    let s = { tokens: 0, updatedAt: 0 };
    s = refill(s, 2500, cfg);
    expect(s.tokens).toBeCloseTo(2.5);
    expect(refill(s, 1_000_000, cfg).tokens).toBe(10);
    const t = take({ tokens: 0.5, updatedAt: 0 }, 1, cfg);
    expect(t).toMatchObject({ ok: false, retryAfterMs: 500 });
    expect(take({ tokens: 3, updatedAt: 0 }, 1, cfg)).toMatchObject({ ok: true, state: { tokens: 2 } });
  });
});

describe('memory store', () => {
  it('allows burst then throttles to the rate', async () => {
    const clock = new FakeClock(0);
    const st = new MemoryRateLimitStore(clock);
    const cfg = { capacity: 3, refillPerMs: 1 / 1000 };
    for (let i = 0; i < 3; i++) expect((await st.take('k', cfg)).allowed).toBe(true);
    const denied = await st.take('k', cfg);
    expect(denied).toEqual({ allowed: false, retryAfterMs: 1000 });
    clock.advance(1000);
    expect((await st.take('k', cfg)).allowed).toBe(true);
  });
});

/** In-memory model of the shared Postgres bucket (same semantics as the upsert). */
class FakeExecutor implements BucketExecutor {
  rows = new Map<string, { tokens: number; updatedAt: number }>();
  writes = 0;
  async lease(key: string, cfg: { capacity: number; refillPerMs: number }, n: number, now: number) {
    this.writes++;
    const r = this.rows.get(key);
    const tokens = r ? Math.min(cfg.capacity, r.tokens + (now - r.updatedAt) * cfg.refillPerMs) : cfg.capacity;
    if (tokens < n) return null;
    this.rows.set(key, { tokens: tokens - n, updatedAt: now });
    return tokens - n;
  }
  async peek(key: string, cfg: { capacity: number; refillPerMs: number }, now: number) {
    const r = this.rows.get(key);
    return r ? Math.min(cfg.capacity, r.tokens + (now - r.updatedAt) * cfg.refillPerMs) : cfg.capacity;
  }
}

describe('lease store', () => {
  it('leases L = ceil(10% capacity) tokens per DB write', async () => {
    const clock = new FakeClock(0);
    const ex = new FakeExecutor();
    const st = new LeaseRateLimitStore(ex, clock);
    const cfg = { capacity: 100, refillPerMs: 0 };
    for (let i = 0; i < 100; i++) expect((await st.take('k', cfg)).allowed).toBe(true);
    expect(ex.writes).toBe(10);
    expect((await st.take('k', cfg)).allowed).toBe(false);
  });

  it('bounds overshoot across replicas to about replicas × L and reports retry-after', async () => {
    const clock = new FakeClock(0);
    const ex = new FakeExecutor();
    const replicas = [new LeaseRateLimitStore(ex, clock), new LeaseRateLimitStore(ex, clock), new LeaseRateLimitStore(ex, clock)];
    const cfg = { capacity: 20, refillPerMs: 1 / 1000 };
    let allowed = 0;
    for (let i = 0; i < 60; i++) if ((await replicas[i % 3]!.take('k', cfg)).allowed) allowed++;
    expect(allowed).toBeLessThanOrEqual(20);
    expect(allowed).toBeGreaterThanOrEqual(20 - 3 * LeaseRateLimitStore.leaseSize(20));
    const r = await replicas[0]!.take('k', cfg);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it('leased local tokens expire after 2 s (never refunded)', async () => {
    const clock = new FakeClock(0);
    const ex = new FakeExecutor();
    const st = new LeaseRateLimitStore(ex, clock);
    const cfg = { capacity: 10, refillPerMs: 0 };
    await st.take('k', cfg); // leases 1 (10% of 10)
    expect(ex.rows.get('k')!.tokens).toBe(9);
    clock.advance(2001);
    await st.take('k', cfg);
    expect(ex.rows.get('k')!.tokens).toBe(8);
  });

  it('compiles the Postgres upsert', async () => {
    const { db, driver } = recordingKysely<MainDB>('postgres');
    expect(await new PgBucketExecutor(db).lease('agent:a', { capacity: 10, refillPerMs: 0.01 }, 1, 5)).toBeNull();
    expect(driver.queries.at(-1)!.sql).toMatch(/insert into rate_limit_buckets[\s\S]*on conflict \(key\) do update set[\s\S]*where least\(/);
  });
});
