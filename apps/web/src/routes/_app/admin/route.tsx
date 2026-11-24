import { Outlet, createFileRoute } from '@tanstack/react-router';
import { AreaError, guard } from '@/app/route-guards';

/** Admin & review area: any admin-ish capability (owners see their scoped pages). Pages add their own guard. */
export const Route = createFileRoute('/_app/admin')({
  beforeLoad: guard([
    'approvals:review', 'accessRequests:review', 'users:read', 'groups:read', 'agents:readAll',
    'servers:read', 'tools:read', 'grants:read', 'settings:read',
  ]),
  errorComponent: AreaError,
  component: Outlet,
});
