import { useQuery } from '@tanstack/react-query';
import { BanIcon, CheckIcon, ClockIcon, HistoryIcon, XIcon, type LucideIcon } from 'lucide-react';
import type { Approval, ApprovalStatus } from '@neurouter/shared';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { Pill, type Tone } from '@/components/status/status';
import { DASH, formatDuration, formatHourMinute } from '@/lib/format';
import { decisionLatencyMs } from './model';
import { resolvedApprovalsQuery } from './queries';

const OUTCOME: Record<ApprovalStatus, { label: string; tone: Tone; icon: LucideIcon }> = {
  pending: { label: 'Pending', tone: 'warn', icon: ClockIcon },
  approved: { label: 'Approved', tone: 'ok', icon: CheckIcon },
  denied: { label: 'Denied', tone: 'err', icon: BanIcon },
  expired: { label: 'Timed out', tone: 'muted', icon: ClockIcon },
  cancelled: { label: 'Cancelled', tone: 'muted', icon: XIcon },
  abandoned: { label: 'Abandoned', tone: 'muted', icon: XIcon },
};

export function OutcomePill({ status }: { status: ApprovalStatus }) {
  const o = OUTCOME[status];
  return (
    <Pill tone={o.tone} icon={o.icon}>
      {o.label}
    </Pill>
  );
}

/** Recent decisions tab (prototype table): tool, agent · user, outcome, decided by, time to decision, when. */
export function RecentDecisions({ mine }: { mine?: boolean }) {
  const q = useQuery(resolvedApprovalsQuery({ limit: 50, ...(mine ? { mine } : {}) }));
  const columns: ColumnSpec<Approval>[] = [
    { id: 'tool', header: 'Tool', priority: 1, cell: (a) => <span className="font-mono text-[12.5px]">{a.tool.qualifiedName}</span> },
    { id: 'who', header: 'Agent · user', priority: 2, cell: (a) => `${a.agent.name} · ${a.user.name}` },
    { id: 'outcome', header: 'Outcome', priority: 1, cell: (a) => <OutcomePill status={a.status} /> },
    { id: 'by', header: 'Decided by', priority: 2, cell: (a) => a.decidedBy?.name ?? DASH },
    { id: 'latency', header: 'Time to decision', align: 'right', priority: 2, cell: (a) => <span className="tabular-nums">{formatDuration(decisionLatencyMs(a))}</span> },
    { id: 'when', header: 'When', cell: (a) => <span className="text-muted-foreground tabular-nums">{a.decidedAt ? formatHourMinute(a.decidedAt) : DASH}</span> },
  ];
  return (
    <DataTable
      label="Recent decisions"
      columns={columns}
      rows={q.data?.items}
      getRowId={(a) => a.id}
      loading={q.isLoading}
      error={q.error}
      onRetry={() => void q.refetch()}
      empty={<EmptyState icon={HistoryIcon} title="No decisions yet" description="Approved, denied and timed-out calls appear here." />}
    />
  );
}
