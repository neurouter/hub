import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api-client';
import { authKeys } from '@/features/auth/queries';

export interface QueryClientHooks {
  /** Session expired mid-use: called once per burst of 401s. */
  onUnauthorized?: () => void;
  /** A mutation was refused (403): show a toast, never redirect. */
  onMutationForbidden?: (err: ApiError) => void;
}

/**
 * QueryClient with the global error policy (frontend §4.4, §6.2): 401 → clear cache + login
 * redirect (debounced), 403 on a query → refresh `me` (roles may have changed), retries only
 * for network/5xx.
 */
export function createQueryClient(hooks: QueryClientHooks = {}): QueryClient {
  let unauthorizedHandled = false;
  function handle401() {
    if (unauthorizedHandled) return;
    unauthorizedHandled = true;
    client.clear();
    hooks.onUnauthorized?.();
    setTimeout(() => (unauthorizedHandled = false), 2000);
  }
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (err, query) => {
        if (!(err instanceof ApiError)) return;
        const isMe = query.queryKey.length === 1 && query.queryKey[0] === authKeys.me[0];
        if (err.status === 401) {
          // the first `me` load is handled by the route guard (redirect with returnTo)
          if (isMe && query.state.data === undefined) return;
          handle401();
        } else if (err.status === 403 && !isMe) {
          void client.invalidateQueries({ queryKey: authKeys.me, exact: true });
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (err) => {
        if (!(err instanceof ApiError)) return;
        if (err.status === 401) handle401();
        else if (err.status === 403) hooks.onMutationForbidden?.(err);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => {
          if (err instanceof ApiError && err.status > 0 && err.status < 500) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
  return client;
}
