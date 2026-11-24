import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import * as z from 'zod';
import { UserPlusIcon } from 'lucide-react';
import { api, can, type AccessRequest, type ApproveAccessRequestBody, type Page as PageT } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { Pill, RequestStatusBadge } from '@/components/status/status';
import { accessRequestsQuery, requestKeys } from '@/features/access-requests/queries';
import { ApproveDialog, DenyDialog } from '@/features/access-requests/review-dialogs';
import { authKeys } from '@/features/auth/queries';
import { grantKeys } from '@/features/grants/queries';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { useMe } from '@/hooks/use-me';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDate, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { toast } from '@/components/ui/toast';

export const Route = createFileRoute('/_app/admin/access-requests')({
  staticData: { crumbs: ['Review', 'Access requests'] },
  validateSearch: z.object({ tab: z.enum(['pending', 'resolved']).optional().catch(undefined) }),
  beforeLoad: guard(['accessRequests:review']),
  errorComponent: AreaError,
  component: AccessRequestsPage,
});

type Decision = { kind: 'approve'; r: AccessRequest; body: ApproveAccessRequestBody } | { kind: 'deny'; r: AccessRequest; note: string };

function AccessRequestsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const { tab = 'pending' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const pager = useCursorStack(tab);
  const list = useQuery({ ...accessRequestsQuery({ status: tab === 'pending' ? 'pending' : 'resolved', cursor: pager.cursor ?? undefined, limit: 50 }), placeholderData: keepPreviousData });
  const [approving, setApproving] = useState<AccessRequest | null>(null);
  const [denying, setDenying] = useState<AccessRequest | null>(null);
  const rows = list.data?.items;

  // Optimistic: the row leaves Pending immediately, rolled back on error (§6.2).
  const decide = useMutation({
    mutationFn: async (d: Decision): Promise<void> => {
      if (d.kind === 'approve') await apiFetch(api.accessRequests.approve, { params: { id: d.r.id }, body: d.body });
      else await apiFetch(api.accessRequests.deny, { params: { id: d.r.id }, body: { note: d.note } });
    },
    onMutate: async (d) => {
      setApproving(null);
      setDenying(null);
      await qc.cancelQueries({ queryKey: requestKeys.all });
      const prev = qc.getQueriesData<PageT<AccessRequest>>({ queryKey: [...requestKeys.all, 'list'] });
      for (const [key, data] of prev) {
        if (data && (key[2] as { status?: string } | undefined)?.status === 'pending') qc.setQueryData(key, { ...data, items: data.items.filter((x) => x.id !== d.r.id) });
      }
      return { prev };
    },
    onError: (err, d, ctx) => {
      for (const [key, data] of (ctx?.prev ?? []) as [QueryKey, unknown][]) qc.setQueryData(key, data);
      if (err instanceof ApiError && err.status === 409) {
        toast.add({ title: 'Already handled', description: `Someone else already decided the request from ${d.r.requester.name}.`, type: 'info' });
        void qc.invalidateQueries({ queryKey: requestKeys.all });
      } else notifyError(err, 'Could not save the decision');
    },
    onSuccess: (_res, d) => {
      notifySuccess(d.kind === 'approve' ? `Approved · grant created for ${d.r.target.name}` : 'Request denied');
      void qc.invalidateQueries({ queryKey: grantKeys.all });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: requestKeys.all });
      void qc.invalidateQueries({ queryKey: authKeys.badges });
    },
  });

  const columns: ColumnSpec<AccessRequest>[] = [
    { id: 'who', header: 'Requester', priority: 1, cell: (r) => <span className="font-medium">{r.requester.name}</span> },
    { id: 'agent', header: 'For agent', priority: 2, cell: (r) => r.agent?.name ?? <span className="text-muted-foreground">—</span> },
    {
      id: 'target',
      header: 'Target',
      priority: 1,
      cell: (r) => (
        <span className="flex flex-col">
          <span className={r.target.type === 'tool' ? 'font-mono text-[12.5px]' : 'font-medium'}>{r.target.name}</span>
          {r.target.type === 'server' ? <span className="text-xs text-muted-foreground">all tools</span> : null}
        </span>
      ),
    },
    { id: 'reason', header: 'Reason', priority: 2, cell: (r) => <span title={r.reason} className="line-clamp-2 max-w-md text-[13px] text-muted-foreground">{r.reason}</span> },
    { id: 'when', header: 'Requested', cell: (r) => <span className="text-muted-foreground" title={formatDate(r.createdAt)}>{formatRelative(r.createdAt)}</span> },
    ...(tab === 'resolved'
      ? [
          { id: 'status', header: 'Status', cell: (r: AccessRequest) => <RequestStatusBadge status={r.status} /> },
          { id: 'reviewer', header: 'Reviewer', cell: (r: AccessRequest) => r.reviewer?.name ?? '—' },
          { id: 'note', header: 'Note', cell: (r: AccessRequest) => <span className="text-muted-foreground">{r.note ?? ''}</span> },
        ]
      : [
          {
            id: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right' as const,
            cell: (r: AccessRequest) =>
              can(me, 'accessRequests:review', { serverId: r.target.server.id }) ? (
                <span className="inline-flex gap-1.5">
                  <Button size="sm" variant="outline" aria-label={`Deny request from ${r.requester.name}`} onClick={() => setDenying(r)}>
                    Deny
                  </Button>
                  <Button size="sm" aria-label={`Approve request from ${r.requester.name}`} onClick={() => setApproving(r)}>
                    Approve
                  </Button>
                </span>
              ) : null,
          },
        ]),
  ];

  return (
    <Page>
      <PageHeader title="Access requests" description="People asking for servers or tools you can grant. Approving creates a grant." />
      <Tabs value={tab} onValueChange={(v) => void navigate({ search: { tab: v === 'pending' ? undefined : (v as 'resolved') } })}>
        <TabsList aria-label="Request status">
          <TabsTrigger value="pending">
            Pending {tab === 'pending' && rows ? <Pill tone="muted" className="h-5">{rows.length}</Pill> : null}
          </TabsTrigger>
          <TabsTrigger value="resolved">Resolved</TabsTrigger>
        </TabsList>
      </Tabs>
      <DataTable
        label={tab === 'pending' ? 'Pending access requests' : 'Resolved access requests'}
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        empty={<EmptyState icon={UserPlusIcon} title={tab === 'pending' ? 'No pending requests' : 'No resolved requests yet'} description={tab === 'pending' ? 'Requests from the catalog appear here.' : undefined} />}
      />
      <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!list.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor)} />
      <ApproveDialog request={approving} onClose={() => setApproving(null)} pending={decide.isPending} onApprove={(r, body) => decide.mutate({ kind: 'approve', r, body })} />
      <DenyDialog request={denying} onClose={() => setDenying(null)} pending={decide.isPending} onDeny={(r, note) => decide.mutate({ kind: 'deny', r, note })} />
    </Page>
  );
}
