import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { api, AuditVerifyResult, type Job } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';
import type { AuditApiFilters } from './search';

export const AUDIT_PAGE_SIZE = 100;

export const auditKeys = {
  all: ['audit'] as const,
  events: (f: AuditApiFilters) => [...auditKeys.all, 'events', f] as const,
  event: (id: string) => [...auditKeys.all, 'event', id] as const,
};

/**
 * Infinite audit list (§6.3): cursor pages of 100, `maxPages` caps memory at ~1,000 rows in the
 * browser (older pages drop off as you load more).
 */
export function auditEventsInfinite(f: AuditApiFilters, limit = AUDIT_PAGE_SIZE) {
  return infiniteQueryOptions({
    queryKey: [...auditKeys.events(f), limit],
    queryFn: ({ pageParam, signal }) => apiFetch(api.audit.events, { query: { ...f, limit, ...(pageParam ? { cursor: pageParam } : {}) }, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    maxPages: 10,
  });
}

export function auditEventQuery(id: string) {
  return queryOptions({ queryKey: auditKeys.event(id), queryFn: ({ signal }) => apiFetch(api.audit.event, { params: { id }, signal }), staleTime: 5 * 60_000 });
}

export const jobKeys = { job: (id: string) => ['jobs', id] as const };

/** Polls an async job every second until it is terminal (§6.4). */
export function jobQuery(id: string | null) {
  return queryOptions({
    queryKey: jobKeys.job(id ?? 'none'),
    queryFn: ({ signal }) => apiFetch(api.jobs.get, { params: { id: id! }, signal }),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data) ? false : 1000),
    staleTime: 0,
  });
}

export function isTerminal(job: Pick<Job, 'status'>): boolean {
  return job.status === 'succeeded' || job.status === 'failed';
}

export function verifyResult(job: Job | undefined): AuditVerifyResult | null {
  if (!job || job.status !== 'succeeded') return null;
  const parsed = AuditVerifyResult.safeParse(job.result);
  return parsed.success ? parsed.data : null;
}
