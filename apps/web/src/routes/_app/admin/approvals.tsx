import { createFileRoute } from '@tanstack/react-router';
import { AreaError, guard } from '@/app/route-guards';
import { ApprovalsPage } from '@/features/approvals/approvals-page';
import * as z from 'zod';

export const Route = createFileRoute('/_app/admin/approvals')({
  staticData: { crumbs: ['Review', 'Approvals'] },
  validateSearch: z.object({ tab: z.enum(['pending', 'recent']).optional().catch(undefined), id: z.string().max(128).optional().catch(undefined) }),
  beforeLoad: guard(['approvals:review']),
  errorComponent: AreaError,
  component: ApprovalsRoute,
});

function ApprovalsRoute() {
  const { tab = 'pending', id } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ApprovalsPage
      tab={tab}
      focusId={id}
      onTab={(t) => void navigate({ search: { tab: t === 'pending' ? undefined : t, id }, replace: true })}
      onClearFocus={() => void navigate({ search: { tab: tab === 'pending' ? undefined : tab }, replace: true })}
    />
  );
}
