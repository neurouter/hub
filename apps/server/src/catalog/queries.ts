import type { Kysely } from 'kysely';
import type { SyncRun } from '@neurouter/shared';
import type { MainDB } from '../db/schema.js';
import { toIso, toIsoOrNull } from '../lib/clock.js';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination.js';

/** Read-only catalog queries that don't belong to a service. */
export class CatalogQueries {
  constructor(private readonly db: Kysely<MainDB>) {}

  async syncRuns(serverId: string, q: { cursor?: string | undefined; limit?: number | undefined }): Promise<{ items: SyncRun[]; nextCursor: string | null }> {
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    let qb = this.db.selectFrom('tool_sync_runs').selectAll().where('server_id', '=', serverId);
    if (key) qb = qb.where((eb) => eb.or([eb('started_at', '<', key[0] as number), eb.and([eb('started_at', '=', key[0] as number), eb('id', '<', key[1] as string)])]));
    const rows = await qb.orderBy('started_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
    const slice = rows.slice(0, limit);
    const last = slice[slice.length - 1];
    return {
      items: slice.map((r) => ({ id: r.id, trigger: r.trigger, status: r.status, startedAt: toIso(r.started_at), finishedAt: toIsoOrNull(r.finished_at), added: r.added, changed: r.changed, removed: r.removed, unchanged: r.unchanged, error: r.error })),
      nextCursor: rows.length > limit && last ? encodeCursor([last.started_at, last.id]) : null,
    };
  }
}
