import { queryOptions } from '@tanstack/react-query';
import { api, type ListServersQuery } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const serverKeys = {
  all: ['servers'] as const,
  list: (f: ListServersQuery) => [...serverKeys.all, 'list', f] as const,
  detail: (id: string) => [...serverKeys.all, 'detail', id] as const,
  health: (id: string, from: string, to: string) => [...serverKeys.detail(id), 'health', from, to] as const,
};

export function serversListQuery(f: ListServersQuery) {
  return queryOptions({ queryKey: serverKeys.list(f), queryFn: ({ signal }) => apiFetch(api.servers.list, { query: f, signal }) });
}

export function serverQuery(id: string) {
  return queryOptions({ queryKey: serverKeys.detail(id), queryFn: ({ signal }) => apiFetch(api.servers.get, { params: { id }, signal }) });
}

export function serverHealthQuery(id: string, from: string, to: string) {
  return queryOptions({ queryKey: serverKeys.health(id, from, to), queryFn: ({ signal }) => apiFetch(api.servers.health, { params: { id }, query: { from, to }, signal }) });
}

export function syncRunsQuery(id: string, cursor?: string) {
  return queryOptions({ queryKey: [...serverKeys.detail(id), 'sync-runs', cursor ?? null] as const, queryFn: ({ signal }) => apiFetch(api.servers.syncRuns, { params: { id }, query: { cursor, limit: 10 }, signal }) });
}
