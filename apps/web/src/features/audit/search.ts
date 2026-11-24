import * as z from 'zod';
import { AuditDecision, AuditStatus, type AuditKind } from '@neurouter/shared';
import { rangeSearchSchema, resolveRange, type RangeSearch } from '@/lib/time-range';

/**
 * `/audit` URL state (frontend §5.3, addendum 8). Every value is validated with `.catch()` so a
 * bad link drops the bad param instead of crashing. The time range is always resolved to a
 * bounded `{ from, to }` before querying (default last 24 h, max 31 days).
 */
const optId = z.string().min(1).max(128).optional().catch(undefined);
const arr = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]), z.array(item).optional()).catch(undefined);

export const AuditKindFilter = z.enum(['tool_call', 'admin', 'all']);
export type AuditKindFilter = z.infer<typeof AuditKindFilter>;

export const auditSearchSchema = rangeSearchSchema.extend({
  q: z.string().max(500).optional().catch(undefined),
  userId: optId,
  agentId: optId,
  serverId: optId,
  toolId: optId,
  sessionId: optId,
  decision: arr(AuditDecision),
  status: arr(AuditStatus),
  kind: AuditKindFilter.optional().catch(undefined),
  event: optId,
});
export type AuditSearch = z.infer<typeof auditSearchSchema>;

/** Decision filter options as the UI groups them (blocked = every `denied_*`). */
export const DECISION_FILTERS: { label: string; values: AuditDecision[] }[] = [
  { label: 'allowed', values: ['allowed'] },
  { label: 'approved by human', values: ['approved'] },
  { label: 'blocked', values: ['denied_acl', 'denied_disabled', 'denied_rate_limit'] },
  { label: 'approval pending', values: ['approval_pending'] },
  { label: 'approval denied', values: ['approval_denied'] },
  { label: 'approval timeout', values: ['approval_timeout'] },
];

export const STATUS_FILTERS: { label: string; value: AuditStatus }[] = [
  { label: 'success', value: 'ok' },
  { label: 'error', value: 'tool_error' },
  { label: 'upstream error', value: 'upstream_error' },
  { label: 'timeout', value: 'timeout' },
  { label: 'invalid args', value: 'invalid_args' },
];

export function kindQuery(kind: AuditKindFilter | undefined): AuditKind[] | undefined {
  if (kind === 'all') return undefined;
  if (kind === 'admin') return ['admin'];
  return ['tool_call'];
}

/** Filters the API receives (range resolved, drawer `event` excluded). Used for the list and the export link. */
export function auditApiFilters(s: AuditSearch, now: number, extra: { scope?: 'me' } = {}) {
  const r = resolveRange(s as RangeSearch, now);
  return {
    from: r.from,
    to: r.to,
    ...(s.userId ? { userId: s.userId } : {}),
    ...(s.agentId ? { agentId: s.agentId } : {}),
    ...(s.serverId ? { serverId: s.serverId } : {}),
    ...(s.toolId ? { toolId: s.toolId } : {}),
    ...(s.sessionId ? { sessionId: s.sessionId } : {}),
    ...(s.decision?.length ? { decision: s.decision } : {}),
    ...(s.status?.length ? { status: s.status } : {}),
    ...(kindQuery(s.kind) ? { kind: kindQuery(s.kind) } : {}),
    ...(s.q ? { q: s.q } : {}),
    ...extra,
  };
}
export type AuditApiFilters = ReturnType<typeof auditApiFilters>;

/** Number of active (non-range, non-default) filters, for "Filters (n)" and "Reset". */
export function activeFilterCount(s: AuditSearch): number {
  return [s.q, s.userId, s.agentId, s.serverId, s.toolId, s.sessionId, s.decision?.length, s.status?.length, s.kind && s.kind !== 'tool_call'].filter(Boolean).length;
}

/** Display names for id filters chosen in pickers (URL keeps ids only). */
export const filterLabels = new Map<string, string>();
