import { queryOptions } from '@tanstack/react-query';
import { api } from '@neurouter/shared';
import { apiFetch } from '@/lib/api-client';

export const settingsKeys = { all: ['settings'] as const, oidc: ['settings', 'oidc'] as const };

export function settingsQuery() {
  return queryOptions({ queryKey: settingsKeys.all, queryFn: ({ signal }) => apiFetch(api.settings.get, { signal }), staleTime: 5 * 60_000 });
}
export function oidcSettingsQuery() {
  return queryOptions({ queryKey: settingsKeys.oidc, queryFn: ({ signal }) => apiFetch(api.settings.oidc, { signal }), staleTime: 5 * 60_000 });
}

type OAuthClientsFilter = { q?: string | undefined; status?: 'active' | 'blocked' | undefined; cursor?: string | undefined; limit?: number };
export const oauthClientKeys = { all: ['oauth-clients'] as const, list: (f: OAuthClientsFilter) => ['oauth-clients', f] as const };
export function oauthClientsQuery(f: OAuthClientsFilter) {
  return queryOptions({ queryKey: oauthClientKeys.list(f), queryFn: ({ signal }) => apiFetch(api.oauth.clients, { query: f, signal }) });
}

export const systemKeys = { info: ['system', 'info'] as const };
export function systemInfoQuery() {
  return queryOptions({ queryKey: systemKeys.info, queryFn: ({ signal }) => apiFetch(api.system.info, { signal }), staleTime: 30_000 });
}
