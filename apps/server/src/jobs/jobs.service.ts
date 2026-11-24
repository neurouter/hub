import type { Kysely } from 'kysely';
import { isAdmin, isAuditor, type Job, type JobKind } from '@neurouter/shared';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { toIso, toIsoOrNull } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../lib/json.js';
import type { UserSubject } from '../identity/principal.js';

const STATUS: Record<'queued' | 'running' | 'ok' | 'error', Job['status']> = { queued: 'queued', running: 'running', ok: 'succeeded', error: 'failed' };

/**
 * Async jobs (`jobs` table) run in-process on the replica that accepted the request; clients poll
 * `GET /api/jobs/:id`. DB status ok/error maps to the API's succeeded/failed.
 */
export class JobsService {
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly log: { warn: (o: object, m: string) => void },
  ) {}

  /** Creates the job row and starts `fn` in the background. Returns the job id immediately. */
  async start<T>(kind: JobKind, params: unknown, createdBy: string | null, fn: (progress: (p: number) => Promise<void>) => Promise<T>): Promise<string> {
    const id = newId();
    await this.db.insertInto('jobs').values({ id, kind, status: 'running', params: toJsonColumn(params ?? null), progress: 0, result: null, error: null, created_by: createdBy, created_at: this.clock.now(), finished_at: null }).execute();
    const progress = async (p: number) => {
      await this.db.updateTable('jobs').set({ progress: Math.max(0, Math.min(1, p)) }).where('id', '=', id).execute();
    };
    const p = (async () => {
      try {
        const result = await fn(progress);
        await this.db.updateTable('jobs').set({ status: 'ok', progress: 1, result: toJsonColumn(result ?? null), finished_at: this.clock.now() }).where('id', '=', id).execute();
      } catch (err) {
        this.log.warn({ err, jobId: id, kind }, 'job failed');
        await this.db.updateTable('jobs').set({ status: 'error', error: (err as Error).message.slice(0, 1000), finished_at: this.clock.now() }).where('id', '=', id).execute().catch(() => {});
      }
    })();
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
    return id;
  }

  /** Resolves when every job started on this replica has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  async get(id: string, viewer: UserSubject): Promise<Job> {
    const row = await this.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row || (row.created_by !== viewer.id && !isAdmin(viewer) && !isAuditor(viewer))) throw AppError.notFound('Job');
    return {
      id: row.id,
      kind: row.kind,
      status: STATUS[row.status],
      progress: row.progress,
      result: parseJsonColumn(row.result),
      error: row.error,
      createdAt: toIso(row.created_at),
      finishedAt: toIsoOrNull(row.finished_at),
    };
  }
}
