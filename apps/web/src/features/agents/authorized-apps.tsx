import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindowIcon } from 'lucide-react';
import { api, type OAuthGrantItem } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { apiFetch } from '@/lib/api-client';
import { formatDate, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { agentKeys, agentOAuthGrantsQuery } from './queries';

/** OAuth clients authorized to act as this agent, with Revoke (§4.5 step 8). */
export function AuthorizedApps({ agentId, canWrite }: { agentId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const q = useQuery(agentOAuthGrantsQuery(agentId));
  const revoke = useMutation({
    mutationFn: (g: OAuthGrantItem) => apiFetch(api.oauth.revokeMyGrant, { params: { id: g.id } }),
    onSuccess: () => {
      notifySuccess('Authorization revoked');
      void qc.invalidateQueries({ queryKey: agentKeys.oauthGrants(agentId) });
    },
    onError: (err) => notifyError(err, 'Could not revoke'),
  });
  const columns: ColumnSpec<OAuthGrantItem>[] = [
    { id: 'client', header: 'App', priority: 1, cell: (g) => <span className="font-medium">{g.client.name}</span> },
    { id: 'scopes', header: 'Scopes', priority: 2, cell: (g) => <span className="font-mono text-[12.5px]">{g.scopes.join(' ')}</span> },
    { id: 'created', header: 'Authorized', cell: (g) => <span className="text-muted-foreground">{formatDate(g.createdAt)}</span> },
    { id: 'used', header: 'Last used', priority: 2, cell: (g) => <span className="text-muted-foreground">{formatRelative(g.lastUsedAt)}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (g) =>
        canWrite ? (
          <Button variant="ghost" size="sm" className="text-destructive" disabled={revoke.isPending} onClick={() => revoke.mutate(g)}>
            Revoke
          </Button>
        ) : null,
    },
  ];
  return (
    <DataTable
      label="Authorized apps"
      columns={columns}
      rows={q.data?.items}
      getRowId={(g) => g.id}
      loading={q.isLoading}
      error={q.error}
      empty={<EmptyState icon={AppWindowIcon} title="No authorized apps" description="Clients that sign in with OAuth as this agent appear here." />}
    />
  );
}
