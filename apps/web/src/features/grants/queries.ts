import { queryOptions } from '@tanstack/react-query';
import { api, type EffectiveAccessQuery, type ListGrantsQuery } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const grantKeys = {
  all: ['grants'] as const,
  list: (f: ListGrantsQuery) => [...grantKeys.all, 'list', f] as const,
  effective: (f: EffectiveAccessQuery) => [...grantKeys.all, 'effective', f] as const,
};

export function grantsListQuery(f: ListGrantsQuery) {
  return queryOptions({ queryKey: grantKeys.list(f), queryFn: ({ signal }) => apiFetch(api.grants.list, { query: f, signal }) });
}

export function effectiveAccessQuery(f: EffectiveAccessQuery) {
  return queryOptions({ queryKey: grantKeys.effective(f), queryFn: ({ signal }) => apiFetch(api.grants.effective, { query: f, signal }), staleTime: 0 });
}
