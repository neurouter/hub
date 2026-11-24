import { sql, type Kysely } from 'kysely';
import type { AuditLogTable, MainDB } from '../db/schema.js';

/** Half-life of the decayed usage score (favorites, §11.5). */
export const USAGE_HALF_LIFE_MS = 7 * 86_400_000;

interface Cell {
  subjectType: 'agent' | 'user';
  subjectId: string;
  toolId: string;
  calls: number;
  successes: number;
  last: number;
}

/** Aggregates committed tool calls into per-(subject, tool) increments. */
export function usageCells(rows: readonly Pick<AuditLogTable, 'kind' | 'tool_id' | 'agent_id' | 'user_id' | 'status' | 'ts'>[]): Cell[] {
  const cells = new Map<string, Cell>();
  for (const r of rows) {
    if (r.kind !== 'tool_call' || !r.tool_id || r.status === 'blocked') continue;
    for (const [subjectType, subjectId] of [['agent', r.agent_id], ['user', r.user_id]] as const) {
      if (!subjectId) continue;
      const k = `${subjectType}|${subjectId}|${r.tool_id}`;
      const c = cells.get(k) ?? { subjectType, subjectId, toolId: r.tool_id, calls: 0, successes: 0, last: 0 };
      c.calls++;
      if (r.status === 'ok') c.successes++;
      c.last = Math.max(c.last, Number(r.ts));
      cells.set(k, c);
    }
  }
  return [...cells.values()];
}

/**
 * `tool_usage_stats` (filled in P1 for P2 ranking): calls, successes and an exponentially decayed
 * score. Written after the audit commit against the control-plane DB (never inside the audit
 * transaction: on SQLite both may share one connection).
 */
export async function recordUsage(db: Kysely<MainDB>, rows: Parameters<typeof usageCells>[0]): Promise<number> {
  const cells = usageCells(rows);
  for (const c of cells) {
    const decay = sql<number>`tool_usage_stats.decayed * exp(-0.6931471805599453 * (${c.last} - coalesce(tool_usage_stats.last_used_at, ${c.last})) / ${USAGE_HALF_LIFE_MS}) + ${c.calls}`;
    await db
      .insertInto('tool_usage_stats')
      .values({ subject_type: c.subjectType, subject_id: c.subjectId, tool_id: c.toolId, calls: c.calls, successes: c.successes, decayed: c.calls, last_used_at: c.last })
      .onConflict((oc) =>
        oc.columns(['subject_type', 'subject_id', 'tool_id']).doUpdateSet({
          calls: sql`tool_usage_stats.calls + ${c.calls}`,
          successes: sql`tool_usage_stats.successes + ${c.successes}`,
          decayed: decay,
          last_used_at: sql`case when tool_usage_stats.last_used_at is null or tool_usage_stats.last_used_at < ${c.last} then ${c.last} else tool_usage_stats.last_used_at end`,
        }),
      )
      .execute();
  }
  return cells.length;
}
