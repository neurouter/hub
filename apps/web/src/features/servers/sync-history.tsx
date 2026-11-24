import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { HistoryIcon } from 'lucide-react';
import type { SyncRun } from '@neurouter/shared';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { Pill } from '@/components/status/status';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { DASH, formatDateTime, formatDuration } from '@/lib/format';
import { syncRunsQuery } from './queries';

const TRIGGER: Record<SyncRun['trigger'], string> = { schedule: 'Scheduled', manual: 'Manual', notification: 'Server notified' };

/** "2 new · 1 changed · 0 removed" (unchanged is left out: it is the usual case). */
export function syncCounts(r: Pick<SyncRun, 'added' | 'changed' | 'removed' | 'status'>): string {
  if (r.status === 'running') return DASH;
  return `${r.added} new · ${r.changed} changed · ${r.removed} removed`;
}

function StatusPill({ run }: { run: SyncRun }) {
  if (run.status === 'running') return <Pill tone="info">Running</Pill>;
  if (run.status === 'error') return <Pill tone="err">Failed</Pill>;
  return <Pill tone="ok">OK</Pill>;
}

/** Sync history of one server (GET /api/servers/:id/sync-runs), newest first. */
export function SyncHistory({ serverId }: { serverId: string }) {
  const pager = useCursorStack(serverId);
  const q = useQuery({ ...syncRunsQuery(serverId, pager.cursor ?? undefined), placeholderData: keepPreviousData });
  const columns: ColumnSpec<SyncRun>[] = [
    { id: 'started', header: 'Started', priority: 1, cell: (r) => <span className="tabular-nums">{formatDateTime(r.startedAt)}</span> },
    { id: 'trigger', header: 'Trigger', cell: (r) => <span className="text-muted-foreground">{TRIGGER[r.trigger]}</span> },
    { id: 'result', header: 'Result', priority: 1, cell: (r) => <StatusPill run={r} /> },
    {
      id: 'changes',
      header: 'Changes',
      priority: 2,
      cell: (r) =>
        r.error ? (
          <span className="text-destructive" title={r.error}>
            {r.error}
          </span>
        ) : (
          <span className={r.changed ? 'text-warning' : 'text-muted-foreground'}>{syncCounts(r)}</span>
        ),
    },
    { id: 'duration', header: 'Duration', align: 'right', cell: (r) => <span className="text-muted-foreground tabular-nums">{r.finishedAt ? formatDuration(Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : DASH}</span> },
  ];
  return (
    <div className="flex flex-col gap-2">
      <DataTable
        label="Sync history"
        columns={columns}
        rows={q.data?.items}
        getRowId={(r) => r.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={HistoryIcon} title="No syncs yet" description="The tool list is synced on a schedule, when the server announces changes, and on demand." />}
      />
      {q.data?.nextCursor || pager.hasPrev ? <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!q.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(q.data?.nextCursor)} /> : null}
    </div>
  );
}
