import { queryOptions } from '@tanstack/react-query';
import { api, type ListCatalogServersQuery, type ListCatalogToolsQuery } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const catalogKeys = {
  all: ['catalog'] as const,
  servers: (f: ListCatalogServersQuery) => [...catalogKeys.all, 'servers', f] as const,
  server: (id: string) => [...catalogKeys.all, 'server', id] as const,
  tools: (f: ListCatalogToolsQuery) => [...catalogKeys.all, 'tools', f] as const,
  tags: ['catalog', 'tags'] as const,
};

export function catalogServersQuery(f: ListCatalogServersQuery) {
  return queryOptions({ queryKey: catalogKeys.servers(f), queryFn: ({ signal }) => apiFetch(api.catalog.servers, { query: f, signal }) });
}
export function catalogServerQuery(id: string) {
  return queryOptions({ queryKey: catalogKeys.server(id), queryFn: ({ signal }) => apiFetch(api.catalog.server, { params: { id }, signal }) });
}
export function catalogToolsQuery(f: ListCatalogToolsQuery) {
  return queryOptions({ queryKey: catalogKeys.tools(f), queryFn: ({ signal }) => apiFetch(api.catalog.tools, { query: f, signal }) });
}
export function catalogTagsQuery() {
  return queryOptions({ queryKey: catalogKeys.tags, queryFn: ({ signal }) => apiFetch(api.catalog.tags, { signal }), staleTime: 5 * 60_000 });
}
