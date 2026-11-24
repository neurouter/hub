import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { RowSelectionState } from '@tanstack/react-table';
import { WrenchIcon } from 'lucide-react';
import { api, can, type ListToolsQuery, type Page as PageT, type ToolRow, type UpdateToolBody } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { ReviewStateBadge } from '@/components/status/status';
import { authKeys } from '@/features/auth/queries';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { useMe } from '@/hooks/use-me';
import { apiFetch } from '@/lib/api-client';
import { formatNumber, formatRelative, plural } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { toolKeys, toolsListQuery } from './queries';

type Patch = Pick<UpdateToolBody, 'enabled' | 'requiresApproval'>;

/**
 * Tools table (§5.2): inline enabled / requires-approval switches (optimistic, rolled back on
 * error), selection with bulk enable / disable / require approval.
 */
export function ToolsTable({ filter, hideServer, empty }: { filter: Omit<ListToolsQuery, 'cursor' | 'limit'>; hideServer?: boolean; empty?: React.ReactNode }) {
  const me = useMe();
  const qc = useQueryClient();
  const pager = useCursorStack(JSON.stringify(filter));
  const q = useQuery({ ...toolsListQuery({ ...filter, cursor: pager.cursor ?? undefined, limit: 50 }), placeholderData: keepPreviousData });
  const [selected, setSelected] = useState<RowSelectionState>({});
  const canWrite = (t: ToolRow) => can(me, 'tools:write', { serverId: t.server.id });

  const patch = useMutation({
    mutationFn: ({ tool, body }: { tool: ToolRow; body: Patch }) => apiFetch(api.tools.update, { params: { id: tool.id }, body }),
    onMutate: async ({ tool, body }) => {
      await qc.cancelQueries({ queryKey: toolKeys.lists() });
      const prev = qc.getQueriesData<PageT<ToolRow>>({ queryKey: toolKeys.lists() });
      qc.setQueriesData<PageT<ToolRow>>({ queryKey: toolKeys.lists() }, (d) => (d ? { ...d, items: d.items.map((t) => (t.id === tool.id ? { ...t, ...body } : t)) } : d));
      return { prev };
    },
    onError: (err, _v, ctx) => {
      for (const [key, data] of (ctx?.prev ?? []) as [QueryKey, unknown][]) qc.setQueryData(key, data);
      notifyError(err, 'Could not update the tool');
    },
    onSettled: (_d, _e, { tool }) => {
      void qc.invalidateQueries({ queryKey: toolKeys.detail(tool.id) });
      void qc.invalidateQueries({ queryKey: authKeys.badges });
    },
  });

  const bulk = useMutation({
    mutationFn: (body: Patch) => apiFetch(api.tools.bulk, { body: { ids: Object.keys(selected).filter((k) => selected[k]), patch: body } }),
    onSuccess: (r) => {
      notifySuccess(`Updated ${plural(r.updated, 'tool')}`, r.skipped.length ? `${r.skipped.length} skipped: ${r.skipped.map((s) => s.reason).join('; ')}` : undefined);
      setSelected({});
      void qc.invalidateQueries({ queryKey: toolKeys.all });
    },
    onError: (err) => notifyError(err, 'Bulk update failed'),
  });

  const columns: ColumnSpec<ToolRow>[] = [
    {
      id: 'name',
      header: 'Tool',
      priority: 1,
      cell: (t) => (
        <Link to="/admin/tools/$toolId" params={{ toolId: t.id }} search={t.reviewState === 'pending_review' ? { tab: 'review' } : {}} className="font-mono text-[12.5px] font-medium underline-offset-4 hover:underline">
          {t.qualifiedName}
        </Link>
      ),
    },
    ...(hideServer ? [] : [{ id: 'server', header: 'Server', cell: (t: ToolRow) => t.server.name }]),
    { id: 'title', header: 'Title', cell: (t) => <span className="text-muted-foreground">{t.title ?? '—'}</span> },
    {
      id: 'enabled',
      header: 'Enabled',
      priority: 2,
      cell: (t) => (
        <Switch
          aria-label={`Enabled: ${t.qualifiedName}`}
          checked={t.enabled}
          disabled={!canWrite(t) || (t.reviewState !== 'approved' && !t.enabled)}
          onCheckedChange={(v) => patch.mutate({ tool: t, body: { enabled: v } })}
        />
      ),
    },
    {
      id: 'approval',
      header: 'Requires approval',
      priority: 2,
      cell: (t) => (
        <Switch aria-label={`Requires approval: ${t.qualifiedName}`} checked={t.requiresApproval} disabled={!canWrite(t)} onCheckedChange={(v) => patch.mutate({ tool: t, body: { requiresApproval: v } })} />
      ),
    },
    { id: 'review', header: 'Review', priority: 1, cell: (t) => <ReviewStateBadge state={t.reviewState} /> },
    { id: 'rate', header: 'Rate limit', cell: (t) => <span className="text-muted-foreground tabular-nums">{t.rateLimit ? `${t.rateLimit.perMinute}/min · burst ${t.rateLimit.burst}` : 'default'}</span> },
    { id: 'calls', header: 'Calls 24h', align: 'right', priority: 2, cell: (t) => formatNumber(t.calls24h) },
    { id: 'last', header: 'Last called', cell: (t) => <span className="text-muted-foreground">{formatRelative(t.lastCalledAt)}</span> },
  ];
  const selectedCount = Object.values(selected).filter(Boolean).length;
  const anyWritable = q.data?.items.some(canWrite);
  return (
    <div className="flex flex-col gap-3">
      <DataTable
        label="Tools"
        columns={columns}
        rows={q.data?.items}
        getRowId={(t) => t.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        rowClassName={(t) => (t.reviewState === 'pending_review' ? 'bg-warning-muted/60' : undefined)}
        {...(anyWritable ? { selection: { selected, onChange: setSelected, rowLabel: (t: ToolRow) => t.qualifiedName, canSelect: canWrite } } : {})}
        empty={empty ?? <EmptyState icon={WrenchIcon} title="No tools match" />}
      />
      <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!q.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(q.data?.nextCursor)} total={q.data?.totalEstimate} />
      {selectedCount > 0 ? (
        <div role="region" aria-label="Bulk actions" className="sticky bottom-4 z-20 flex flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3 shadow-lg">
          <span className="flex-1 text-[13.5px] font-medium">{plural(selectedCount, 'tool')} selected</span>
          <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate({ enabled: true })}>
            Enable
          </Button>
          <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate({ enabled: false })}>
            Disable
          </Button>
          <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate({ requiresApproval: true })}>
            Require approval
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected({})}>
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}
