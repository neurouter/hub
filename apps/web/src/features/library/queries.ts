import { queryOptions } from '@tanstack/react-query';
import { api, type ListLibraryQuery } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const libraryKeys = {
  all: ['library'] as const,
  status: () => [...libraryKeys.all, 'status'] as const,
  list: (f: ListLibraryQuery) => [...libraryKeys.all, 'list', f] as const,
  detail: (id: string) => [...libraryKeys.all, 'detail', id] as const,
};

export function libraryStatusQuery() {
  return queryOptions({ queryKey: libraryKeys.status(), queryFn: ({ signal }) => apiFetch(api.library.status, { signal }) });
}

export function libraryListQuery(f: ListLibraryQuery) {
  return queryOptions({ queryKey: libraryKeys.list(f), queryFn: ({ signal }) => apiFetch(api.library.list, { query: f, signal }) });
}

export function libraryEntryQuery(id: string) {
  return queryOptions({ queryKey: libraryKeys.detail(id), queryFn: ({ signal }) => apiFetch(api.library.get, { params: { id }, signal }) });
}

export function serverQualityQuery(id: string) {
  return queryOptions({ queryKey: ['servers', 'detail', id, 'quality'] as const, queryFn: ({ signal }) => apiFetch(api.servers.quality, { params: { id }, signal }) });
}
