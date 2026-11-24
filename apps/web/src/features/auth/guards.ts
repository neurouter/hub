import { redirect } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { canAny, primaryRole, type Badges, type Capability, type CapabilityResource, type Me } from '@neurouter/shared';
import { ApiError } from '@/lib/api-client';
import { meQueryOptions } from './queries';

export { isSafeReturnTo } from '@neurouter/shared';

/** Thrown by area guards; the area's errorComponent renders <ForbiddenState/> in place (URL unchanged). */
export class ForbiddenError extends Error {
  constructor(readonly required: readonly Capability[]) {
    super('You do not have access to this page');
    this.name = 'ForbiddenError';
  }
}

export function isForbiddenError(e: unknown): e is ForbiddenError {
  return e instanceof ForbiddenError || (e instanceof ApiError && e.status === 403);
}

/**
 * `beforeLoad` guard for the authenticated shell: loads `/api/me`, or redirects to the login
 * page with `returnTo` on 401 (TanStack authenticated-routes pattern). UX only; the server authorizes.
 */
export async function requireAuth(ctx: { context: { queryClient: QueryClient }; location: { href: string } }): Promise<Me> {
  try {
    return await ctx.context.queryClient.ensureQueryData(meQueryOptions());
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw redirect({ to: '/auth/login', search: { returnTo: ctx.location.href } });
    }
    throw err;
  }
}

/** Throws ForbiddenError unless the user holds at least one of `caps`. */
export function requireAnyCapability(me: Me, caps: readonly Capability[], resource?: CapabilityResource): void {
  if (!canAny(me, caps, resource)) throw new ForbiddenError(caps);
}

/** Landing page per role (frontend §3.2, Q1). */
export function landingPath(me: Me, badges?: Pick<Badges, 'pendingApprovals'> | null): string {
  const role = primaryRole(me);
  if (role === 'admin' || role === 'auditor') return '/observability';
  if (role === 'owner') return badges && badges.pendingApprovals > 0 ? '/admin/approvals' : '/catalog';
  return '/catalog';
}
