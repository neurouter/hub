import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { HttpResponse } from 'msw';
import { PROBLEM_CONTENT_TYPE, problemType, type Badges, type Me } from '@neurouter/shared';
import { Providers } from '@/app/providers';
import { createQueryClient } from '@/app/query-client';
import { createAppRouter } from '@/app/router';
import { createContractHandlers, defaultFixtures, type ContractFixtures } from '@/mocks/handlers';
import { badgesFixture } from '@/mocks/fixtures';
import { setCsrfToken } from '@/lib/api-client';
import { server } from './msw-server';

export const unauthenticated = () =>
  HttpResponse.json(
    { type: problemType('unauthenticated'), title: 'Authentication required', status: 401, code: 'unauthenticated', requestId: 't' },
    { status: 401, headers: { 'content-type': PROBLEM_CONTENT_TYPE } },
  );

/**
 * Renders the real route tree at `path` with memory history, a fresh QueryClient and
 * contract-generated MSW handlers, so guards, loaders and search validation run for real.
 */
export async function renderRoute(path: string, opts: { me?: Me | null; badges?: Partial<Badges>; fixtures?: ContractFixtures } = {}) {
  setCsrfToken(null);
  const fixtures: ContractFixtures = {
    ...defaultFixtures(),
    ...(opts.me === null ? { 'me.me': unauthenticated } : opts.me ? { 'me.me': opts.me } : {}),
    ...(opts.badges ? { 'me.badges': badgesFixture(opts.badges) } : {}),
    ...opts.fixtures,
  };
  server.use(...createContractHandlers(fixtures));
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false, refetchInterval: false, refetchOnWindowFocus: false } });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ queryClient, history });
  const user = userEvent.setup();
  const utils = render(
    <Providers queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  await router.load();
  return { ...utils, router, queryClient, user };
}
