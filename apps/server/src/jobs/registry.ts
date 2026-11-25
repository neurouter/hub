import type { Services } from '../deps.js';
import { compactHours, pruneRollups } from '../observability/rollups.js';
import type { JobScheduler } from './scheduler.js';

/** Leader-only background jobs (backend §17 jobs registry). */
export function registerJobs(scheduler: JobScheduler, s: Services): void {
  scheduler.register({
    name: 'session-cleanup',
    schedule: '0 */15 * * * *',
    run: async () => {
      await s.sessions.purgeExpired();
      await s.login.purgeExpiredStates();
    },
  });
  scheduler.register({ name: 'tool-sync', schedule: '0 * * * * *', leaseMs: 10 * 60_000, run: async () => void (await s.catalog.syncDue()) });
  scheduler.register({ name: 'health-check', schedule: '30 * * * * *', leaseMs: 5 * 60_000, run: async () => void (await s.health.checkAll()) });
  scheduler.register({ name: 'icon-refresh', schedule: '0 10 4 * * *', run: () => s.catalog.refreshIcons() });
  scheduler.register({ name: 'upstream-token-refresh', schedule: '20 */5 * * * *', leaseMs: 10 * 60_000, run: async () => void (await s.upstreamOAuth.refreshDue()) });
  scheduler.register({
    name: 'oauth-cleanup',
    schedule: '40 */15 * * * *',
    run: async () => {
      await s.oauthTokens.cleanup();
      await s.upstreamOAuth.cleanupStates();
    },
  });
  scheduler.register({ name: 'approval-janitor', schedule: '*/30 * * * * *', run: async () => void (await s.approvals.sweep()) });
  // vectors for new/changed tools (no-op until the embedding model is ready; tool sync also kicks it)
  scheduler.register({ name: 'search-index', schedule: '45 */2 * * * *', leaseMs: 10 * 60_000, run: async () => void (await s.indexer.run()) });

  // MCP server library: hourly, as the registry asks aggregators to (no-op while sync is disabled)
  scheduler.register({ name: 'library-sync', schedule: '0 7 * * * *', leaseMs: 60 * 60_000, run: async () => void (await s.library.sync()) });
  // raise grade confidence a few servers at a time (no-op unless sync and auto-check are on)
  scheduler.register({ name: 'library-checks', schedule: '0 3-59/10 * * * *', leaseMs: 15 * 60_000, run: async () => void (await s.library.checkBatch()) });

  registerAuditJobs(scheduler, s);
}

/** Steps 5–6: audit checkpoints, retention (+archive), partitions, sinks; rollup compaction and retention. */
export function registerAuditJobs(scheduler: JobScheduler, s: Services): void {
  scheduler.register({ name: 'audit-checkpoint', schedule: '15 * * * * *', run: async () => void (await s.auditStore.periodicCheckpoint()) });
  scheduler.register({ name: 'audit-retention', schedule: '0 15 3 * * *', leaseMs: 60 * 60_000, run: () => runAuditRetention(s) });
  scheduler.register({
    name: 'audit-partitions',
    schedule: '0 5 0 * * *',
    runOnStart: true,
    run: async () => {
      const res = await s.auditStore.maintainPartitions();
      for (const f of res.failed) s.logger.warn({ partition: f.name, error: f.error }, 'audit partition could not be created');
    },
  });
  scheduler.register({ name: 'audit-sinks', schedule: '*/5 * * * * *', leaseMs: 5 * 60_000, run: async () => void (await s.sinkDispatcher.runOnce()) });
  scheduler.register({ name: 'rollup-compaction', schedule: '0 5 * * * *', run: async () => {
    await s.rollups.flush();
    await compactHours(s.dbs.audit.db, s.dbs.audit.dialect, s.clock.now());
  } });
  scheduler.register({ name: 'rollup-retention', schedule: '0 30 3 * * *', run: async () => void (await pruneRollups(s.dbs.audit.db, s.clock.now(), await s.settings.get('metricsRetention'))) });
}

/** Daily retention (§9.6): audit (checkpoint → archive → delete), sessions, decided approvals and access requests. */
export async function runAuditRetention(s: Services): Promise<void> {
  const days = await s.settings.get('auditRetentionDays');
  const cutoff = s.clock.now() - days * 86_400_000;
  const out = await s.auditStore.applyRetention(cutoff);
  let approvals = 0;
  let accessRequests = 0;
  if (!out.skipped) {
    const a = await s.dbs.main.db.deleteFrom('approvals').where('status', '!=', 'pending').where('created_at', '<', cutoff).executeTakeFirst();
    approvals = Number(a.numDeletedRows);
    accessRequests = await s.accessRequests.prune(cutoff);
  }
  const changes = { ...out, cutoff: new Date(cutoff).toISOString(), approvals, accessRequests };
  s.audit.system('audit.retention', out.skipped ? { reason: 'archive failed; nothing deleted', changes } : { changes });
}
