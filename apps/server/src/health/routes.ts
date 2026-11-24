import type { FastifyInstance } from 'fastify';
import { pingDatabase, type Databases } from '../db/index.js';
import type { AuditStore } from '../audit/store.js';

export interface HealthDeps {
  dbs: Databases;
  auditStore: AuditStore;
  version: string;
  /** extra readiness checks registered by later steps (OIDC discovery, embeddings…) */
  extraChecks?: Record<string, () => Promise<{ ok: boolean; error?: string }>>;
}

/** /healthz (liveness), /readyz (readiness: DB + audit store), and /health (alias of /healthz). */
export async function healthRoutes(app: FastifyInstance, deps: HealthDeps): Promise<void> {
  const live = async () => ({ status: 'ok' as const, version: deps.version });
  app.get('/healthz', { logLevel: 'warn' }, live);
  app.get('/health', { logLevel: 'warn' }, live);

  app.get('/readyz', { logLevel: 'warn' }, async (_req, reply) => {
    const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string; detail?: string }> = {};
    const main = await pingDatabase(deps.dbs.main);
    checks.database = main.ok
      ? { ok: true, latencyMs: main.latencyMs, ...(main.version ? { detail: main.version } : {}) }
      : { ok: false, error: main.error };
    if (deps.dbs.separateAudit) {
      const audit = await pingDatabase(deps.dbs.audit);
      checks.auditDatabase = audit.ok ? { ok: true, latencyMs: audit.latencyMs } : { ok: false, error: audit.error };
    }
    checks.auditStore = await deps.auditStore.health();
    for (const [name, fn] of Object.entries(deps.extraChecks ?? {})) {
      try {
        checks[name] = await fn();
      } catch (err) {
        checks[name] = { ok: false, error: (err as Error).message };
      }
    }
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', version: deps.version, checks });
  });
}
