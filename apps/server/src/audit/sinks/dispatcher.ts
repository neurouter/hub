import type { Kysely } from 'kysely';
import type { AuditDB } from '../../db/schema.js';
import type { Clock } from '../../lib/clock.js';
import type { AuditStore } from '../store.js';
import type { AuditSink } from './sink.js';

export const SINK_BATCH = 500;
export const SINK_BACKOFF_BASE_MS = 5_000;
export const SINK_BACKOFF_MAX_MS = 60 * 60_000;

export function backoffMs(failures: number): number {
  return Math.min(SINK_BACKOFF_MAX_MS, SINK_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * Sink dispatcher (§9.7, leader job every 5 s): reads rows after `audit_sink_cursors.last_seq`
 * in batches of 500, delivers them (with the checkpoints in that range) and advances the cursor
 * only after a successful delivery, so delivery is at-least-once. Failures back off
 * exponentially (max 1 h) and are recorded in `last_error`.
 */
export class SinkDispatcher {
  private readonly backoff = new Map<string, { failures: number; nextAt: number }>();

  constructor(
    private readonly o: {
      db: Kysely<AuditDB>;
      store: AuditStore;
      sinks: () => Promise<AuditSink[]>;
      clock: Clock;
      log: { warn(o: object, m: string): void };
      batchSize?: number;
      maxBatchesPerRun?: number;
    },
  ) {}

  async cursor(sink: string): Promise<number> {
    const r = await this.o.db.selectFrom('audit_sink_cursors').select('last_seq').where('sink', '=', sink).executeTakeFirst();
    return r ? Number(r.last_seq) : 0;
  }

  private async save(sink: string, lastSeq: number, error: string | null): Promise<void> {
    const now = this.o.clock.now();
    await this.o.db
      .insertInto('audit_sink_cursors')
      .values({ sink, last_seq: lastSeq, updated_at: now, last_error: error })
      .onConflict((oc) => oc.column('sink').doUpdateSet({ last_seq: lastSeq, updated_at: now, last_error: error }))
      .execute();
  }

  async runOnce(): Promise<Record<string, { delivered: number; error: string | null; skipped?: boolean }>> {
    const out: Record<string, { delivered: number; error: string | null; skipped?: boolean }> = {};
    for (const sink of await this.o.sinks()) {
      const now = this.o.clock.now();
      const b = this.backoff.get(sink.name);
      if (b && b.nextAt > now) {
        out[sink.name] = { delivered: 0, error: null, skipped: true };
        continue;
      }
      let seq = await this.cursor(sink.name);
      let delivered = 0;
      let error: string | null = null;
      for (let i = 0; i < (this.o.maxBatchesPerRun ?? 20); i++) {
        const batch = await this.o.store.readAfter(seq, this.o.batchSize ?? SINK_BATCH);
        if (!batch.rows.length) break;
        try {
          await sink.deliver(batch);
        } catch (err) {
          error = (err as Error).message.slice(0, 500);
          const failures = (this.backoff.get(sink.name)?.failures ?? 0) + 1;
          this.backoff.set(sink.name, { failures, nextAt: now + backoffMs(failures) });
          this.o.log.warn({ err, sink: sink.name, failures }, 'audit sink delivery failed');
          await this.save(sink.name, seq, error);
          break;
        }
        seq = Number(batch.rows[batch.rows.length - 1]!.seq);
        delivered += batch.rows.length;
        this.backoff.delete(sink.name);
        await this.save(sink.name, seq, null);
      }
      out[sink.name] = { delivered, error };
    }
    return out;
  }
}
