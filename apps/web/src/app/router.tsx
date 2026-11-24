import { createRouter, type RouterHistory } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { routeTree } from '@/routeTree.gen';
import { ErrorState, PageSkeleton } from '@/components/feedback/states';
import { NotFound } from '@/routes/__root';
import './route-meta';

export function createAppRouter({ queryClient, history }: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    context: { queryClient },
    ...(history ? { history } : {}),
    defaultPreload: 'intent',
    // let TanStack Query own freshness
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultPendingComponent: PageSkeleton,
    defaultErrorComponent: ({ error, reset }) => <ErrorState error={error} onRetry={reset} />,
    defaultNotFoundComponent: NotFound,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
