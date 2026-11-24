import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { BotIcon } from 'lucide-react';
import { api, can, type Agent } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { SearchInput } from '@/components/filters/search-input';
import { PageHeader } from '@/components/layout/page-header';
import { Page, Toolbar } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { agentKeys, agentsListQuery } from '@/features/agents/queries';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { useMe } from '@/hooks/use-me';
import { apiFetch } from '@/lib/api-client';
import { formatNumber, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

export const Route = createFileRoute('/_app/admin/agents')({
  staticData: { crumbs: ['Administration', 'Agents'], readOnly: { read: 'agents:readAll', write: 'users:write' } },
  validateSearch: z.object({ q: z.string().max(200).optional().catch(undefined) }),
  beforeLoad: guard(['agents:readAll']),
  errorComponent: AreaError,
  component: AllAgentsPage,
});

function AllAgentsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const { q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const pager = useCursorStack(q ?? '');
  const list = useQuery({ ...agentsListQuery({ owner: 'all', q, cursor: pager.cursor ?? undefined, limit: 50 }), placeholderData: keepPreviousData });
  const [revoking, setRevoking] = useState<Agent | null>(null);
  const canRevoke = can(me, 'users:write');
  const revokeAll = useMutation({
    mutationFn: (a: Agent) => apiFetch(api.agents.revokeAllKeys, { params: { id: a.id } }),
    onSuccess: (r, a) => {
      notifySuccess(`Revoked ${r.revoked} key${r.revoked === 1 ? '' : 's'} of ${a.name}`);
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: agentKeys.all });
    },
    onError: (err) => notifyError(err, 'Could not revoke keys'),
  });
  const columns: ColumnSpec<Agent>[] = [
    { id: 'name', header: 'Agent', priority: 1, cell: (a) => <span className="font-medium">{a.name}</span> },
    { id: 'owner', header: 'Owner', priority: 2, cell: (a) => a.owner.name },
    { id: 'kind', header: 'Type', cell: (a) => <Pill tone="muted">{a.kind === 'oauth_client' ? 'OAuth client' : 'API keys'}</Pill> },
    { id: 'keys', header: 'Active keys', align: 'right', priority: 2, cell: (a) => formatNumber(a.activeKeyCount) },
    { id: 'used', header: 'Last used', priority: 2, cell: (a) => <span className="text-muted-foreground">{formatRelative(a.lastUsedAt)}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (a) => (
        <span className="inline-flex gap-1">
          <Button variant="ghost" size="sm" aria-label={`View ${a.name}`} onClick={() => void navigate({ to: '/agents/$agentId', params: { agentId: a.id } })}>
            View
          </Button>
          {canRevoke && a.activeKeyCount > 0 ? (
            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRevoking(a)}>
              Revoke all keys
            </Button>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <Page>
      <PageHeader title="Agents" description="Every agent in the organisation, with its owner and key status." />
      <Toolbar>
        <SearchInput label="Search agents" placeholder="Search by agent or owner…" value={q} onChange={(v) => void navigate({ search: { q: v } })} />
      </Toolbar>
      <DataTable
        label="All agents"
        columns={columns}
        rows={list.data?.items}
        getRowId={(a) => a.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        empty={<EmptyState icon={BotIcon} title={q ? `No agents match “${q}”` : 'No agents yet'} />}
      />
      <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!list.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor)} total={list.data?.totalEstimate} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke all keys of ${revoking?.name ?? ''}?`}
        description={`${revoking?.activeKeyCount ?? 0} active key(s) stop working immediately. The owner (${revoking?.owner.name ?? ''}) can create new ones.`}
        confirmLabel="Revoke all keys"
        pending={revokeAll.isPending}
        onConfirm={() => revoking && revokeAll.mutate(revoking)}
      />
    </Page>
  );
}
