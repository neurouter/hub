import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import type { JobsService } from '../jobs/jobs.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { HealthService } from './health.js';
import type { IconService } from './icons.js';
import type { SyncTrigger, ToolSyncService } from './tool-sync.js';

/** Orchestrates sync / health / icon work as async jobs and scheduled runs. */
export class CatalogService {
  constructor(
    private readonly d: { db: Kysely<MainDB>; clock: Clock; jobs: JobsService; toolSync: ToolSyncService; health: HealthService; icons: IconService; settings: SettingsService; logger: Pick<Logger, 'warn' | 'info'> },
  ) {}

  /** `POST /servers/:id/sync` and the initial sync after create: always a 202 job (D9). */
  startSync(serverId: string, trigger: SyncTrigger, actorId: string | null, opts: { initial?: boolean } = {}): Promise<string> {
    return this.d.jobs.start('tool_sync', { serverId, trigger }, actorId, async () => {
      if (opts.initial) {
        await this.d.health.check(serverId).catch(() => null);
      }
      const r = await this.d.toolSync.sync(serverId, trigger);
      if (opts.initial) await this.d.icons.refresh(serverId).catch(() => null);
      return { added: r.added, changed: r.changed, removed: r.removed, unchanged: r.unchanged };
    });
  }

  /** Scheduled sync (every minute, leader only): servers whose interval elapsed. */
  async syncDue(): Promise<number> {
    const now = this.d.clock.now();
    const def = await this.d.settings.get('toolSyncDefaultIntervalMin');
    const rows = await this.d.db.selectFrom('servers').select(['id', 'last_synced_at', 'sync_interval_min']).where('enabled', '=', 1).where('status', '!=', 'disabled').execute();
    let n = 0;
    for (const s of rows) {
      const every = (s.sync_interval_min ?? def) * 60_000;
      if (s.last_synced_at !== null && now - s.last_synced_at < every) continue;
      try {
        await this.d.toolSync.sync(s.id, 'schedule');
        n++;
      } catch (err) {
        this.d.logger.warn({ err, serverId: s.id }, 'scheduled tool sync failed');
      }
    }
    return n;
  }

  /** Daily icon refresh for servers with an icon source. */
  async refreshIcons(): Promise<void> {
    const rows = await this.d.db.selectFrom('servers').select('id').where('status', '!=', 'disabled').execute();
    for (const r of rows) await this.d.icons.refresh(r.id).catch(() => null);
  }
}
