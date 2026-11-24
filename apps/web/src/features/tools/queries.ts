import { queryOptions } from '@tanstack/react-query';
import { api, type ListToolsQuery } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const toolKeys = {
  all: ['tools'] as const,
  lists: () => [...toolKeys.all, 'list'] as const,
  list: (f: ListToolsQuery) => [...toolKeys.lists(), f] as const,
  detail: (id: string) => [...toolKeys.all, 'detail', id] as const,
  diff: (id: string) => [...toolKeys.detail(id), 'diff'] as const,
};

export function toolsListQuery(f: ListToolsQuery) {
  return queryOptions({ queryKey: toolKeys.list(f), queryFn: ({ signal }) => apiFetch(api.tools.list, { query: f, signal }) });
}
export function toolQuery(id: string) {
  return queryOptions({ queryKey: toolKeys.detail(id), queryFn: ({ signal }) => apiFetch(api.tools.get, { params: { id }, signal }) });
}
export function definitionDiffQuery(id: string) {
  return queryOptions({ queryKey: toolKeys.diff(id), queryFn: ({ signal }) => apiFetch(api.tools.definitionDiff, { params: { id }, signal }), staleTime: 5_000 });
}
export function toolVersionsQuery(id: string, cursor?: string) {
  return queryOptions({ queryKey: [...toolKeys.detail(id), 'versions', cursor ?? null] as const, queryFn: ({ signal }) => apiFetch(api.tools.versions, { params: { id }, query: { cursor, limit: 20 }, signal }) });
}
