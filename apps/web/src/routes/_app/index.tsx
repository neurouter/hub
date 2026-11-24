import { createFileRoute, redirect } from '@tanstack/react-router';
import { isServerOwner } from '@neurouter/shared';
import { landingPath } from '@/features/auth/guards';
import { badgesQueryOptions, meQueryOptions } from '@/features/auth/queries';

/** `/` → landing page per role (frontend §3.2). */
export const Route = createFileRoute('/_app/')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions());
    let badges = null;
    if (isServerOwner(me)) badges = await context.queryClient.ensureQueryData(badgesQueryOptions()).catch(() => null);
    throw redirect({ to: landingPath(me, badges), replace: true });
  },
});
