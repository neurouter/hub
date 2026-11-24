import { queryOptions } from '@tanstack/react-query';
import { api, type ListGroupsQuery } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const groupKeys = {
  all: ['groups'] as const,
  list: (f: ListGroupsQuery) => [...groupKeys.all, 'list', f] as const,
  detail: (id: string) => [...groupKeys.all, 'detail', id] as const,
  members: (id: string) => [...groupKeys.detail(id), 'members'] as const,
  mappings: (id: string) => [...groupKeys.detail(id), 'mappings'] as const,
};

export function groupsListQuery(f: ListGroupsQuery) {
  return queryOptions({ queryKey: groupKeys.list(f), queryFn: ({ signal }) => apiFetch(api.groups.list, { query: f, signal }) });
}
export function groupQuery(id: string) {
  return queryOptions({ queryKey: groupKeys.detail(id), queryFn: ({ signal }) => apiFetch(api.groups.get, { params: { id }, signal }) });
}
export function groupMembersQuery(id: string) {
  return queryOptions({ queryKey: groupKeys.members(id), queryFn: ({ signal }) => apiFetch(api.groups.members, { params: { id }, query: { limit: 200 }, signal }) });
}
export function groupMappingsQuery(id: string) {
  return queryOptions({ queryKey: groupKeys.mappings(id), queryFn: ({ signal }) => apiFetch(api.groups.claimMappings, { params: { id }, signal }) });
}
