import { createFileRoute } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { InboxIcon } from 'lucide-react';
import type { AccessRequest } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { RequestStatusBadge } from '@/components/status/status';
import { myRequestsQuery } from '@/features/access-requests/queries';
import { formatDate } from '@/lib/format';
import { useCancelRequest } from './catalog/index';

export const Route = createFileRoute('/_app/requests')({
  staticData: { crumbs: ['Portal', 'My requests'] },
  component: MyRequestsPage,
});

/** My access requests (§5.1): target, reason, status, reviewer, decided at, note; Cancel while pending. */
function MyRequestsPage() {
  const q = useQuery(myRequestsQuery({ limit: 200 }));
  const cancel = useCancelRequest();
  const columns: ColumnSpec<AccessRequest>[] = [
    { id: 'target', header: 'Target', priority: 1, cell: (r) => <span className={r.target.type === 'tool' ? 'font-mono text-[12.5px]' : 'font-medium'}>{r.target.name}</span> },
    { id: 'reason', header: 'Reason', priority: 2, cell: (r) => <span className="line-clamp-2 max-w-md text-[13px] text-muted-foreground">{r.reason}</span> },
    { id: 'status', header: 'Status', priority: 1, cell: (r) => <RequestStatusBadge status={r.status} /> },
    { id: 'reviewer', header: 'Reviewer', cell: (r) => r.reviewer?.name ?? '—' },
    { id: 'decided', header: 'Decided', cell: (r) => <span className="text-muted-foreground">{r.decidedAt ? formatDate(r.decidedAt) : '—'}</span> },
    { id: 'note', header: 'Note', priority: 2, cell: (r) => <span className="text-[13px]">{r.note ?? ''}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) =>
        r.status === 'pending' ? (
          <Button variant="ghost" size="sm" aria-label={`Cancel request for ${r.target.name}`} disabled={cancel.isPending} onClick={() => cancel.mutate(r)}>
            Cancel
          </Button>
        ) : null,
    },
  ];
  return (
    <Page>
      <PageHeader title="My requests" description="Access you asked for, and what reviewers decided." />
      <DataTable
        label="My access requests"
        columns={columns}
        rows={q.data?.items}
        getRowId={(r) => r.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={InboxIcon} title="No requests yet" description="Request access to servers or tools from the catalog." action={<Button variant="outline" render={<Link to="/catalog" />}>Open the catalog</Button>} />}
      />
    </Page>
  );
}
