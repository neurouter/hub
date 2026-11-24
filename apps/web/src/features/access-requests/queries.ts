import { queryOptions } from '@tanstack/react-query';
import { api, type ListAccessRequestsQuery, type ListMyAccessRequestsQuery } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const requestKeys = {
  all: ['access-requests'] as const,
  list: (f: ListAccessRequestsQuery) => [...requestKeys.all, 'list', f] as const,
  mine: (f: ListMyAccessRequestsQuery) => [...requestKeys.all, 'mine', f] as const,
};

export function accessRequestsQuery(f: ListAccessRequestsQuery) {
  return queryOptions({ queryKey: requestKeys.list(f), queryFn: ({ signal }) => apiFetch(api.accessRequests.list, { query: f, signal }) });
}
export function myRequestsQuery(f: ListMyAccessRequestsQuery) {
  return queryOptions({ queryKey: requestKeys.mine(f), queryFn: ({ signal }) => apiFetch(api.accessRequests.listMine, { query: f, signal }) });
}
