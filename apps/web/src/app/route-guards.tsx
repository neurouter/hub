import type { ErrorComponentProps } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { Capability } from '@neurouter/shared';
import { ErrorState, ForbiddenState } from '@/components/feedback/states';
import { isForbiddenError, requireAnyCapability } from '@/features/auth/guards';
import { meQueryOptions } from '@/features/auth/queries';

export interface RouterContext {
  queryClient: QueryClient;
}

/** `beforeLoad` for an area: the user must hold at least one of `caps` (UX only; the API authorizes). */
export function guard(caps: readonly Capability[]) {
  return async ({ context }: { context: RouterContext }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions());
    requireAnyCapability(me, caps);
  };
}

/** Area error boundary: 403 → ForbiddenState in place, anything else → ErrorState. */
export function AreaError({ error, reset }: ErrorComponentProps) {
  if (isForbiddenError(error)) return <ForbiddenState />;
  return <ErrorState error={error} onRetry={reset} />;
}
