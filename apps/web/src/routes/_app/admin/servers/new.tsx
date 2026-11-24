import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AreaError, guard } from '@/app/route-guards';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { ServerForm } from '@/features/servers/server-form';
import { serverKeys } from '@/features/servers/queries';
import { useFollowInitialSync } from '@/features/servers/use-sync';
import { useMe } from '@/hooks/use-me';
import { notifySuccess } from '@/lib/notify';

export const Route = createFileRoute('/_app/admin/servers/new')({
  staticData: { crumbs: ['Administration', 'Servers', 'Register'] },
  beforeLoad: guard(['servers:create']),
  errorComponent: AreaError,
  component: NewServerPage,
});

function NewServerPage() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const followInitialSync = useFollowInitialSync();
  return (
    <Page width="form">
      <PageHeader title="Register a server" description="Connect an upstream MCP server. Its tools are discovered and stay disabled until reviewed." />
      <ServerForm
        me={{ id: me.user.id, name: me.user.name }}
        onRegistered={(id, jobId) => {
          void qc.invalidateQueries({ queryKey: serverKeys.all });
          void followInitialSync(id, jobId);
          notifySuccess('Server registered', 'Initial sync started. New tools stay disabled until reviewed.');
          void navigate({ to: '/admin/servers/$serverId', params: { serverId: id }, search: { tab: 'tools' } });
        }}
      />
    </Page>
  );
}
