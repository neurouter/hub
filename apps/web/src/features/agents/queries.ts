import { queryOptions } from '@tanstack/react-query';
import { api, type ListAgentsQuery } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const agentKeys = {
  all: ['agents'] as const,
  lists: () => [...agentKeys.all, 'list'] as const,
  list: (f: ListAgentsQuery) => [...agentKeys.lists(), f] as const,
  detail: (id: string) => [...agentKeys.all, 'detail', id] as const,
  keys: (id: string) => [...agentKeys.detail(id), 'keys'] as const,
  scope: (id: string) => [...agentKeys.detail(id), 'scope'] as const,
  oauthGrants: (id: string) => [...agentKeys.detail(id), 'oauth-grants'] as const,
  access: (id: string) => [...agentKeys.detail(id), 'access'] as const,
};

export function agentsListQuery(f: ListAgentsQuery) {
  return queryOptions({
    queryKey: agentKeys.list(f),
    queryFn: ({ signal }) => apiFetch(api.agents.list, { query: f, signal }),
  });
}

export function agentQuery(id: string) {
  return queryOptions({ queryKey: agentKeys.detail(id), queryFn: ({ signal }) => apiFetch(api.agents.get, { params: { id }, signal }) });
}

export function agentKeysQuery(id: string) {
  return queryOptions({ queryKey: agentKeys.keys(id), queryFn: ({ signal }) => apiFetch(api.agents.keys, { params: { id }, signal }) });
}

export function agentScopeQuery(id: string) {
  return queryOptions({ queryKey: agentKeys.scope(id), queryFn: ({ signal }) => apiFetch(api.agents.getScope, { params: { id }, signal }) });
}

export function agentAccessQuery(id: string) {
  return queryOptions({ queryKey: agentKeys.access(id), queryFn: ({ signal }) => apiFetch(api.agents.access, { params: { id }, signal }) });
}
export function agentOAuthGrantsQuery(id: string) {
  return queryOptions({ queryKey: agentKeys.oauthGrants(id), queryFn: ({ signal }) => apiFetch(api.oauth.myGrants, { query: { agentId: id }, signal }) });
}

/** Expiry choices for new keys (§5.1): 30/90/365 days, a custom date, or never. */
export const KEY_EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'custom', label: 'Custom date' },
  { value: 'never', label: 'Never expires' },
] as const;
export type KeyExpiryChoice = (typeof KEY_EXPIRY_OPTIONS)[number]['value'];

/** Resolves the expiry choice to the API value (`null` = never). Returns `undefined` when invalid. */
export function resolveKeyExpiry(choice: KeyExpiryChoice, customDate: string, now: number = Date.now()): string | null | undefined {
  if (choice === 'never') return null;
  if (choice === 'custom') {
    const t = Date.parse(`${customDate}T23:59:59.000Z`);
    return Number.isNaN(t) || t <= now ? undefined : new Date(t).toISOString();
  }
  return new Date(now + Number(choice) * 86_400_000).toISOString();
}
