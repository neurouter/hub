import { queryOptions } from '@tanstack/react-query';
import { api, type ListUsersQuery } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const userKeys = {
  all: ['users'] as const,
  list: (f: ListUsersQuery) => [...userKeys.all, 'list', f] as const,
  detail: (id: string) => [...userKeys.all, 'detail', id] as const,
};

export function usersListQuery(f: ListUsersQuery) {
  return queryOptions({ queryKey: userKeys.list(f), queryFn: ({ signal }) => apiFetch(api.users.list, { query: f, signal }) });
}

export function userQuery(id: string) {
  return queryOptions({ queryKey: userKeys.detail(id), queryFn: ({ signal }) => apiFetch(api.users.get, { params: { id }, signal }) });
}
