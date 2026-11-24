import { Outlet, createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { AreaError } from '@/app/route-guards';
import { AppShell } from '@/components/layout/app-shell';
import { useThemeAccountSync } from '@/components/theme/use-theme-account-sync';
import { requireAuth } from '@/features/auth/guards';
import { meQueryOptions } from '@/features/auth/queries';

/** Authenticated shell (pathless). Unauthenticated users are redirected to /auth/login?returnTo=… */
export const Route = createFileRoute('/_app')({
  beforeLoad: requireAuth,
  component: AppLayout,
  errorComponent: AreaError,
});

function AppLayout() {
  const { data: me } = useSuspenseQuery(meQueryOptions());
  useThemeAccountSync(me);
  return (
    <AppShell me={me}>
      <Outlet />
    </AppShell>
  );
}
