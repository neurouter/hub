import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ActivityIcon } from 'lucide-react';
import { EmptyState } from '@/components/feedback/states';
import { useTimeRange } from '@/hooks/use-time-range';
import type { RangeSearch } from '@/lib/time-range';
import { AuditEventDrawer } from './event-drawer';
import { AuditTable } from './audit-table';
import { auditEventsInfinite } from './queries';
import type { AuditApiFilters } from './search';

/**
 * Compact audit table (agent Activity tab, My activity) with its own drawer state.
 * `scope: 'me'` limits plain users to their own events (backend forces it anyway, A8).
 */
export function RecentActivity({ filter, range = { range: '24h' }, auditLink }: { filter: Partial<Omit<AuditApiFilters, 'from' | 'to'>>; range?: RangeSearch; auditLink?: { agentId?: string } }) {
  const r = useTimeRange(range);
  const filters = useMemo(() => ({ from: r.from, to: r.to, kind: ['tool_call' as const], ...filter }), [r.from, r.to, filter]);
  const q = useInfiniteQuery(auditEventsInfinite(filters as AuditApiFilters, 50));
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items), [q.data]);
  const [open, setOpen] = useState<string | undefined>();
  return (
    <div className="flex flex-col gap-2">
      <AuditTable
        compact
        maxHeight="28rem"
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        hasNextPage={q.hasNextPage}
        isFetchingNextPage={q.isFetchingNextPage}
        onLoadMore={() => void q.fetchNextPage()}
        onOpen={setOpen}
        activeId={open}
        empty={<EmptyState icon={ActivityIcon} title="No calls in this range" />}
      />
      {auditLink ? (
        <Link to="/audit" search={{ ...auditLink, range: range.range }} className="self-end text-[13px] font-medium underline-offset-4 hover:underline">
          Open in audit log →
        </Link>
      ) : null}
      <AuditEventDrawer eventId={open} onClose={() => setOpen(undefined)} />
    </div>
  );
}
