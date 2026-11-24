import { sql, type Kysely, type SelectQueryBuilder, type SqlBool } from 'kysely';
import type { AuditDB } from '../db/schema.js';
import type { Dialect } from '../db/url.js';
import { AppError } from '../lib/errors.js';
import type { AuditQuery, AuditRow, DecisionCount } from './types.js';

/**
 * FTS query sanitizer. User input never reaches the FTS5 / tsquery grammar: tokens are reduced
 * to letters/digits/`_.-@`, quoted (FTS5) and AND-ed; the last token gets prefix matching.
 * Returns null when nothing searchable remains.
 */
export function ftsQuery(q: string, dialect: Dialect): string | null {
  const tokens = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.@-]+/u)
    .map((t) => t.replace(/^[.@-]+|[.@-]+$/g, ''))
    .filter((t) => t.length > 0)
    .slice(0, 16);
  if (!tokens.length) return null;
  if (dialect === 'sqlite') return tokens.map((t, i) => `"${t.replace(/"/g, '')}"${i === tokens.length - 1 ? '*' : ''}`).join(' ');
  // to_tsquery('simple'): quote-free lexemes joined with &; prefix on the last
  return tokens.map((t, i) => `'${t.replace(/[':\\&|!()<>*]/g, ' ').trim().replace(/\s+/g, '-')}'${i === tokens.length - 1 ? ':*' : ''}`).join(' & ');
}

type Q = SelectQueryBuilder<AuditDB, 'audit_log', object>;

/** Applies every filter. The time range always applies first (partition pruning on PG). */
export function applyFilters<O>(qb: SelectQueryBuilder<AuditDB, 'audit_log', O>, q: Omit<AuditQuery, 'limit' | 'cursorSeq' | 'order'>, dialect: Dialect, ftsEnabled = true): SelectQueryBuilder<AuditDB, 'audit_log', O> {
  if (!(q.to > q.from)) throw AppError.validation('`to` must be after `from`', [{ path: ['to'], message: 'Must be after from', code: 'invalid_range' }]);
  let x = qb.where('audit_log.ts', '>=', q.from).where('audit_log.ts', '<', q.to);
  if (q.serverIds !== undefined) x = q.serverIds.length ? x.where('audit_log.server_id', 'in', [...q.serverIds]) : x.where(sql<SqlBool>`1 = 0`);
  if (q.userId) x = x.where('audit_log.user_id', '=', q.userId);
  if (q.agentId) x = x.where('audit_log.agent_id', '=', q.agentId);
  if (q.toolId) x = x.where('audit_log.tool_id', '=', q.toolId);
  if (q.sessionId) x = x.where('audit_log.session_id', '=', q.sessionId);
  if (q.traceId) x = x.where('audit_log.trace_id', '=', q.traceId.toLowerCase());
  if (q.decisions?.length) x = x.where('audit_log.decision', 'in', [...q.decisions]);
  if (q.statuses?.length) x = x.where('audit_log.status', 'in', [...q.statuses]);
  if (q.kinds?.length) x = x.where('audit_log.kind', 'in', [...q.kinds]);
  if (q.q) {
    if (!ftsEnabled) throw AppError.validation('Full-text search is disabled', [{ path: ['q'], message: 'Full-text search over audit events is disabled by the administrator', code: 'fts_disabled' }]);
    const fq = ftsQuery(q.q, dialect);
    if (!fq) return x.where(sql<SqlBool>`1 = 0`);
    x =
      dialect === 'sqlite'
        ? x.where(sql<SqlBool>`audit_log.seq in (select rowid from audit_fts where audit_fts match ${fq})`)
        : x.where(sql<SqlBool>`audit_log.params_tsv @@ to_tsquery('simple', ${fq})`);
  }
  return x;
}

export async function queryRows(db: Kysely<AuditDB>, dialect: Dialect, q: AuditQuery, ftsEnabled = true): Promise<{ rows: AuditRow[]; nextSeq: number | null }> {
  const desc = (q.order ?? 'desc') === 'desc';
  let qb = applyFilters(db.selectFrom('audit_log').selectAll('audit_log'), q, dialect, ftsEnabled) as unknown as Q;
  if (q.cursorSeq !== undefined && q.cursorSeq !== null) qb = qb.where('audit_log.seq', desc ? '<' : '>', q.cursorSeq);
  const rows = (await qb.orderBy('audit_log.seq', desc ? 'desc' : 'asc').limit(q.limit + 1).execute()) as AuditRow[];
  const page = rows.slice(0, q.limit);
  return { rows: page, nextSeq: rows.length > q.limit ? Number(page[page.length - 1]!.seq) : null };
}

/** Streams matching rows in pages (bounded memory; export with backpressure). */
export async function* streamRows(db: Kysely<AuditDB>, dialect: Dialect, q: Omit<AuditQuery, 'limit' | 'cursorSeq'>, maxRows: number, pageSize = 1000, ftsEnabled = true): AsyncGenerator<AuditRow> {
  let cursor: number | null = null;
  let sent = 0;
  while (sent < maxRows) {
    const { rows, nextSeq } = await queryRows(db, dialect, { ...q, cursorSeq: cursor, limit: Math.min(pageSize, maxRows - sent) }, ftsEnabled);
    for (const r of rows) {
      yield r;
      sent++;
    }
    if (nextSeq === null || !rows.length) return;
    cursor = nextSeq;
  }
}

/** Blocked calls by decision and reason (metrics `block_reason` breakdown). */
export async function decisionCounts(db: Kysely<AuditDB>, dialect: Dialect, q: Omit<AuditQuery, 'limit' | 'cursorSeq' | 'order'>): Promise<DecisionCount[]> {
  const rows = await applyFilters(
    db.selectFrom('audit_log').select(['audit_log.decision', 'audit_log.decision_reason', sql<number>`count(*)`.as('n')]),
    q,
    dialect,
  )
    .groupBy(['audit_log.decision', 'audit_log.decision_reason'])
    .execute();
  return rows.map((r) => ({ decision: r.decision, reason: r.decision_reason, count: Number(r.n) }));
}

/** Calls per minute bucket for the filter (session detail mini chart). */
export async function countsByMinute(db: Kysely<AuditDB>, dialect: Dialect, q: Omit<AuditQuery, 'limit' | 'cursorSeq' | 'order'>): Promise<{ t: number; calls: number }[]> {
  const bucket = sql<number>`(audit_log.ts - (audit_log.ts % 60000))`;
  const rows = await applyFilters(db.selectFrom('audit_log').select([bucket.as('b'), sql<number>`count(*)`.as('n')]), q, dialect)
    .groupBy(bucket)
    .orderBy(bucket)
    .execute();
  return rows.map((r) => ({ t: Number(r.b), calls: Number(r.n) }));
}

/** Row count capped at `cap + 1` (export truncation header without a full count). */
export async function countCapped(db: Kysely<AuditDB>, dialect: Dialect, q: Omit<AuditQuery, 'limit' | 'cursorSeq' | 'order'>, cap: number, ftsEnabled = true): Promise<number> {
  const inner = applyFilters(db.selectFrom('audit_log').select(sql<number>`1`.as('one')), q, dialect, ftsEnabled).limit(cap + 1);
  const r = await db.selectFrom(inner.as('x')).select(sql<number>`count(*)`.as('n')).executeTakeFirst();
  return Number(r?.n ?? 0);
}
