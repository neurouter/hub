import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheckIcon, TrashIcon } from 'lucide-react';
import { api, type Grant, type ListGrantsQuery } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { EffectBadge } from '@/components/status/status';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { apiFetch } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { grantKeys, grantsListQuery } from './queries';
import { SubjectCell } from './subject';

/**
 * Grants list (§5.2 Access control list view), reused on group/server/tool pages with a fixed
 * filter. Effect is icon + text (distinguishable without colour, W4 acceptance).
 */
export function GrantsTable({ filter, canWrite, hideSubject, hideTarget }: { filter: Omit<ListGrantsQuery, 'cursor' | 'limit'>; canWrite: boolean; hideSubject?: boolean; hideTarget?: boolean }) {
  const qc = useQueryClient();
  const pager = useCursorStack(JSON.stringify(filter));
  const q = useQuery({ ...grantsListQuery({ ...filter, cursor: pager.cursor ?? undefined, limit: 50 }), placeholderData: keepPreviousData });
  const [deleting, setDeleting] = useState<Grant | null>(null);
  const del = useMutation({
    mutationFn: (g: Grant) => apiFetch(api.grants.delete, { params: { id: g.id } }),
    onSuccess: () => {
      notifySuccess('Grant removed');
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: grantKeys.all });
    },
    onError: (err) => notifyError(err, 'Could not remove the grant'),
  });
  const columns: ColumnSpec<Grant>[] = [
    ...(hideSubject ? [] : [{ id: 'subject', header: 'Subject', priority: 1 as const, cell: (g: Grant) => <SubjectCell type={g.subject.type} name={g.subject.name} /> }]),
    ...(hideTarget
      ? []
      : [
          {
            id: 'target',
            header: 'Target',
            priority: 1 as const,
            cell: (g: Grant) => (g.target.type === 'server' ? <span><span className="font-medium">{g.target.name}</span> <span className="text-muted-foreground">(all tools)</span></span> : <span className="font-mono text-[12.5px]">{g.target.name}</span>),
          },
        ]),
    { id: 'effect', header: 'Effect', priority: 1, cell: (g) => <EffectBadge effect={g.effect} /> },
    {
      id: 'source',
      header: 'Source',
      priority: 2,
      cell: (g) =>
        g.source === 'access_request' ? (
          <Link to="/admin/access-requests" search={{ tab: 'resolved' }} className="text-[13px] underline-offset-4 hover:underline">
            Access request
          </Link>
        ) : (
          <span className="text-muted-foreground">manual</span>
        ),
    },
    { id: 'created', header: 'Created', cell: (g) => <span className="text-muted-foreground">{formatDate(g.createdAt)} · {g.createdBy.name}</span> },
    { id: 'expires', header: 'Expires', priority: 2, cell: (g) => <span className="text-muted-foreground">{g.expiresAt ? formatDate(g.expiresAt) : 'Never'}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (g) =>
        canWrite ? (
          <Button variant="ghost" size="icon-sm" aria-label={`Remove grant ${g.subject.type}:${g.subject.name} on ${g.target.name}`} onClick={() => setDeleting(g)}>
            <TrashIcon />
          </Button>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <DataTable
        label="Grants"
        columns={columns}
        rows={q.data?.items}
        getRowId={(g) => g.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        className="rounded-none border-0"
        empty={<EmptyState icon={ShieldCheckIcon} title="No grants" description="Nothing is allowed until a grant exists. Deny always wins over allow." />}
      />
      <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!q.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(q.data?.nextCursor)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Remove this grant?"
        description={deleting ? `${deleting.subject.type}:${deleting.subject.name} → ${deleting.target.name} (${deleting.effect}). Takes effect on the next call.` : undefined}
        confirmLabel="Remove grant"
        pending={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
      />
    </div>
  );
}
