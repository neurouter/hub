import { queryOptions } from '@tanstack/react-query';
import { api } from '@neurouter/shared';
import { apiFetch, setCsrfToken } from '@/lib/api-client';
import { serverClock } from '@/lib/server-time';

export const authKeys = {
  me: ['me'] as const,
  badges: ['me', 'badges'] as const,
  providers: ['auth', 'providers'] as const,
};

/** `/api/me` (frontend §4.3): staleTime 5 min, refetch on focus; keeps the CSRF token current. */
export function meQueryOptions() {
  return queryOptions({
    queryKey: authKeys.me,
    queryFn: async ({ signal }) => {
      const me = await apiFetch(api.me.me, { signal });
      setCsrfToken(me.csrfToken);
      serverClock.sync(me.serverTime);
      return me;
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

/** Sidebar counts, polled every 30 s (frontend §3.3). */
export function badgesQueryOptions() {
  return queryOptions({
    queryKey: authKeys.badges,
    queryFn: ({ signal }) => apiFetch(api.me.badges, { signal }),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function providersQueryOptions() {
  return queryOptions({
    queryKey: authKeys.providers,
    queryFn: ({ signal }) => apiFetch(api.auth.providers, { signal }),
    staleTime: 5 * 60_000,
  });
}
