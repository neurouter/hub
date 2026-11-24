import type { Kysely } from 'kysely';
import type { Health, HealthHistory } from '@neurouter/shared';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { toIso, toIsoOrNull } from '../lib/clock.js';
import { fromBool, toBool } from '../lib/json.js';
import { UpstreamError } from '../upstream/errors.js';
import type { UpstreamPool } from '../upstream/pool.js';

export type HealthStatus = Health['status'];

/** Status rules (backend §6): up < 2 s; degraded ≥ 2 s or 1–2 consecutive failures; down ≥ 3 failures or circuit open. */
export function healthStatus(p: { ok: boolean; latencyMs: number; consecutiveFailures: number; circuitOpen: boolean }): HealthStatus {
  if (p.circuitOpen || p.consecutiveFailures >= 3) return 'down';
  if (!p.ok) return 'degraded';
  return p.latencyMs >= 2000 ? 'degraded' : 'up';
}

export const HEALTH_RETENTION_MS = 7 * 86_400_000;

export class HealthService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly pool: UpstreamPool,
  ) {}

  async current(serverId: string): Promise<Health> {
    const h = await this.db.selectFrom('server_health').selectAll().where('server_id', '=', serverId).executeTakeFirst();
    return h ? { status: h.status, latencyMs: h.latency_ms, checkedAt: toIsoOrNull(h.checked_at) } : { status: 'unknown', latencyMs: null, checkedAt: null };
  }

  /** server/discover (modern) or initialize (legacy), 5 s timeout. Per-user OAuth servers are checked without a credential: a 401 means reachable. */
  async check(serverId: string): Promise<Health> {
    const s = await this.db.selectFrom('servers').selectAll().where('id', '=', serverId).executeTakeFirst();
    if (!s) throw new Error(`Server ${serverId} not found`);
    const start = performance.now();
    let ok = false;
    let error: string | null = null;
    try {
      await this.pool.probe(
        { id: s.id, name: s.name, url: s.url, transport: s.transport, authMode: s.auth_mode, timeoutMs: 5000, ...(s.auth_mode === 'user_oauth' ? { headers: {} } : {}) },
        { timeoutMs: 5000 },
      );
      ok = true;
    } catch (err) {
      if (s.auth_mode === 'user_oauth' && err instanceof UpstreamError && err.kind === 'auth_required') ok = true;
      else error = (err as Error).message.slice(0, 500);
    }
    const latencyMs = Math.round(performance.now() - start);
    const now = this.clock.now();
    const prev = await this.db.selectFrom('server_health').select('consecutive_failures').where('server_id', '=', serverId).executeTakeFirst();
    const failures = ok ? 0 : (prev?.consecutive_failures ?? 0) + 1;
    const breaker = this.pool.breaker(serverId);
    if (ok && breaker.state !== 'closed') breaker.onSuccess();
    const status = healthStatus({ ok, latencyMs, consecutiveFailures: failures, circuitOpen: breaker.state === 'open' });
    const row = { status, latency_ms: ok ? latencyMs : null, checked_at: now, error, consecutive_failures: failures };
    await this.db
      .insertInto('server_health')
      .values({ server_id: serverId, ...row })
      .onConflict((oc) => oc.column('server_id').doUpdateSet(row))
      .execute();
    await this.db
      .insertInto('server_health_checks')
      .values({ server_id: serverId, checked_at: now, ok: fromBool(ok), latency_ms: ok ? latencyMs : null })
      .onConflict((oc) => oc.columns(['server_id', 'checked_at']).doNothing())
      .execute();
    return { status, latencyMs: row.latency_ms, checkedAt: toIso(now) };
  }

  /** Marks a server down when its circuit opens. */
  async markDown(serverId: string, reason: string): Promise<void> {
    const now = this.clock.now();
    await this.db
      .insertInto('server_health')
      .values({ server_id: serverId, status: 'down', latency_ms: null, checked_at: now, error: reason, consecutive_failures: 5 })
      .onConflict((oc) => oc.column('server_id').doUpdateSet({ status: 'down', checked_at: now, error: reason }))
      .execute();
  }

  async history(serverId: string, from: number, to: number): Promise<HealthHistory> {
    const rows = await this.db.selectFrom('server_health_checks').selectAll().where('server_id', '=', serverId).where('checked_at', '>=', from).where('checked_at', '<=', to).orderBy('checked_at').limit(10_000).execute();
    let failures = 0;
    return {
      points: rows.map((r) => {
        failures = toBool(r.ok) ? 0 : failures + 1;
        return { t: toIso(r.checked_at), status: healthStatus({ ok: toBool(r.ok), latencyMs: r.latency_ms ?? 0, consecutiveFailures: failures, circuitOpen: false }), latencyMs: r.latency_ms };
      }),
    };
  }

  /** Health job (every 60 s, leader only): checks enabled servers, concurrency 10; prunes checks older than 7 days. */
  async checkAll(concurrency = 10): Promise<number> {
    const servers = await this.db.selectFrom('servers').select('id').where('enabled', '=', 1).where('status', '!=', 'disabled').execute();
    const queue = servers.map((s) => s.id);
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let id = queue.shift(); id; id = queue.shift()) await this.check(id).catch(() => {});
      }),
    );
    await this.db.deleteFrom('server_health_checks').where('checked_at', '<', this.clock.now() - HEALTH_RETENTION_MS).execute();
    return servers.length;
  }
}
