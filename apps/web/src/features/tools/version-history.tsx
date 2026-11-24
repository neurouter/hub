import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { HistoryIcon } from 'lucide-react';
import type { ToolVersion } from '@neurouter/shared';
import { CopyableMono } from '@/components/code/copy-button';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { Pill } from '@/components/status/status';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { DASH, formatDateTime, shortHash } from '@/lib/format';
import { toolVersionsQuery } from './queries';

const DECISION: Record<ToolVersion['decision'], { label: string; tone: 'ok' | 'warn' | 'err' | 'muted' }> = {
  pending: { label: 'Pending review', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'err' },
  superseded: { label: 'Superseded', tone: 'muted' },
};

/** Definition history of a tool (GET /api/tools/:id/versions): every hash seen and its review decision. */
export function VersionHistory({ toolId, pinnedHash }: { toolId: string; pinnedHash: string | null }) {
  const pager = useCursorStack(toolId);
  const q = useQuery({ ...toolVersionsQuery(toolId, pager.cursor ?? undefined), placeholderData: keepPreviousData });
  const columns: ColumnSpec<ToolVersion>[] = [
    {
      id: 'hash',
      header: 'Definition',
      priority: 1,
      cell: (v) => (
        <span className="inline-flex items-center gap-2">
          <CopyableMono value={v.hash} display={shortHash(v.hash)} ariaLabel={`Copy hash ${shortHash(v.hash)}`} />
          {v.hash === pinnedHash ? <Pill tone="info">Pinned</Pill> : null}
        </span>
      ),
    },
    { id: 'seen', header: 'First seen', priority: 2, cell: (v) => <span className="tabular-nums text-muted-foreground">{formatDateTime(v.firstSeenAt)}</span> },
    { id: 'decision', header: 'Decision', priority: 1, cell: (v) => <Pill tone={DECISION[v.decision].tone}>{DECISION[v.decision].label}</Pill> },
    { id: 'by', header: 'Decided', cell: (v) => <span className="text-muted-foreground">{v.decidedAt ? `${formatDateTime(v.decidedAt)}${v.decidedBy ? ` · ${v.decidedBy.name}` : ''}` : DASH}</span> },
  ];
  return (
    <div className="flex flex-col gap-2">
      <DataTable
        label="Definition history"
        columns={columns}
        rows={q.data?.items}
        getRowId={(v) => v.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={HistoryIcon} title="No history yet" description="Each definition the server reports is recorded here with its review decision." />}
      />
      {q.data?.nextCursor || pager.hasPrev ? <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!q.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(q.data?.nextCursor)} /> : null}
    </div>
  );
}
