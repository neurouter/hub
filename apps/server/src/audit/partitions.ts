import { sql, type Kysely } from 'kysely';
import type { AuditDB } from '../db/schema.js';

export const DAY_MS = 86_400_000;

export function dayStart(ms: number): number {
  return ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
}

/** `audit_log_p20261124` for the UTC day containing `ms`. */
export function partitionName(ms: number): string {
  return `audit_log_p${new Date(dayStart(ms)).toISOString().slice(0, 10).replace(/-/g, '')}`;
}

/** Parses a daily partition name back to its [start, end) range; null for others (default). */
export function partitionRange(name: string): { start: number; end: number } | null {
  const m = /^audit_log_p(\d{4})(\d{2})(\d{2})$/.exec(name);
  if (!m) return null;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(start) ? null : { start, end: start + DAY_MS };
}

/** DDL for one daily partition (bounds are epoch-ms literals; identifiers are generated, not user input). */
export function createPartitionSql(dayMs: number): string {
  const start = dayStart(dayMs);
  return `create table if not exists ${partitionName(start)} partition of audit_log for values from (${start}) to (${start + DAY_MS})`;
}

/**
 * Postgres partition maintenance (§9.6): keeps today plus `daysAhead` daily partitions. A day
 * whose rows already sit in the DEFAULT partition can't get its own partition (PG refuses);
 * that is reported and the rows stay in DEFAULT until retention deletes them.
 */
export async function ensurePartitions(db: Kysely<AuditDB>, now: number, daysAhead = 7): Promise<{ created: string[]; failed: { name: string; error: string }[] }> {
  const existing = new Set(await listPartitions(db));
  const created: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (let i = 0; i <= daysAhead; i++) {
    const day = dayStart(now) + i * DAY_MS;
    const name = partitionName(day);
    if (existing.has(name)) continue;
    try {
      await sql.raw(createPartitionSql(day)).execute(db);
      created.push(name);
    } catch (err) {
      failed.push({ name, error: (err as Error).message });
    }
  }
  return { created, failed };
}

export async function listPartitions(db: Kysely<AuditDB>): Promise<string[]> {
  const res = await sql<{ name: string }>`select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'audit_log'::regclass`.execute(db);
  return res.rows.map((r) => r.name);
}

/** Daily partitions whose whole range is older than the cutoff (safe to DROP). */
export function droppable(names: readonly string[], cutoff: number): string[] {
  return names.filter((n) => {
    const r = partitionRange(n);
    return r !== null && r.end <= cutoff;
  });
}
