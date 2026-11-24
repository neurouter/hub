import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { api, type ListSessionsQuery } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const sessionKeys = {
  all: ['sessions'] as const,
  list: (f: ListSessionsQuery) => [...sessionKeys.all, 'list', f] as const,
  detail: (id: string) => [...sessionKeys.all, 'detail', id] as const,
  events: (id: string) => [...sessionKeys.detail(id), 'events'] as const,
};

export function sessionsListQuery(f: ListSessionsQuery) {
  return queryOptions({ queryKey: sessionKeys.list(f), queryFn: ({ signal }) => apiFetch(api.sessions.list, { query: f, signal }) });
}
export function sessionQuery(id: string) {
  return queryOptions({ queryKey: sessionKeys.detail(id), queryFn: ({ signal }) => apiFetch(api.sessions.get, { params: { id }, signal }) });
}
export function sessionEventsInfinite(id: string) {
  return infiniteQueryOptions({
    queryKey: sessionKeys.events(id),
    queryFn: ({ pageParam, signal }) => apiFetch(api.sessions.events, { params: { id }, query: { limit: 200, ...(pageParam ? { cursor: pageParam } : {}) }, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    maxPages: 10,
  });
}
