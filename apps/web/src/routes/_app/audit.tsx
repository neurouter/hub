import { useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { FileSearchIcon, InfoIcon } from 'lucide-react';
import { can, isOwnerScoped } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { Button } from '@/components/ui/button';
import { AuditEventDrawer } from '@/features/audit/event-drawer';
import { AuditFilters } from '@/features/audit/audit-filters';
import { AuditTable } from '@/features/audit/audit-table';
import { ExportMenu } from '@/features/audit/export-menu';
import { auditEventsInfinite } from '@/features/audit/queries';
import { activeFilterCount, auditApiFilters, auditSearchSchema, type AuditSearch } from '@/features/audit/search';
import { VerifyDialog } from '@/features/audit/verify-dialog';
import { useMe } from '@/hooks/use-me';
import { useTimeRange } from '@/hooks/use-time-range';
import { useFilterNames } from '@/features/lookup/names';

export const Route = createFileRoute('/_app/audit')({
  staticData: { crumbs: ['Audit & observability', 'Audit log'] },
  validateSearch: auditSearchSchema,
  beforeLoad: guard(['audit:read']),
  errorComponent: AreaError,
  component: AuditPage,
});

function AuditPage() {
  const me = useMe();
  const search = Route.useSearch();
  useFilterNames([search.userId, search.agentId, search.serverId, search.toolId]);
  const navigate = useNavigate({ from: Route.fullPath });
  const range = useTimeRange(search);
  const filters = useMemo(() => auditApiFilters({ ...search, range: range.key, from: range.from, to: range.to }, range.toMs), [search, range.key, range.from, range.to, range.toMs]);
  const q = useInfiniteQuery({ ...auditEventsInfinite(filters), placeholderData: keepPreviousData });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items), [q.data]);

  const patch = (p: Partial<AuditSearch>) => void navigate({ search: (s) => ({ ...s, ...p }), replace: false });
  /** Display names for id filters from the loaded rows (URL keeps ids only). */
  const lookup = (id: string) => {
    for (const e of rows ?? []) {
      if (e.user?.id === id) return e.user.name;
      if (e.agent?.id === id) return e.agent.name;
      if (e.server?.id === id) return e.server.name;
    }
    return undefined;
  };
  const filtered = activeFilterCount(search) > 0;

  return (
    <Page>
      <PageHeader
        title="Audit log"
        description="Every gateway decision and admin change. Append-only and hash-chained."
        actions={
          <>
            {can(me, 'audit:verify') ? <VerifyDialog /> : null}
            {can(me, 'audit:export') ? <ExportMenu filters={filters} /> : null}
          </>
        }
      />
      <AuditFilters
        me={me}
        search={search}
        range={range}
        lookup={lookup}
        onChange={patch}
        onRange={(r) => patch({ range: r.range, from: r.from, to: r.to })}
      />
      {isOwnerScoped(me, 'audit:read') ? (
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <InfoIcon className="size-3.5" aria-hidden="true" /> Showing events for servers you own.
        </p>
      ) : null}
      <AuditTable
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        hasNextPage={q.hasNextPage}
        isFetchingNextPage={q.isFetchingNextPage}
        onLoadMore={() => void q.fetchNextPage()}
        activeId={search.event}
        onOpen={(id) => patch({ event: id })}
        empty={
          filtered ? (
            <EmptyState icon={FileSearchIcon} title="No events match these filters" action={<Button variant="outline" onClick={() => patch({ q: undefined, userId: undefined, agentId: undefined, serverId: undefined, toolId: undefined, decision: undefined, status: undefined, kind: undefined, sessionId: undefined })}>Reset filters</Button>} />
          ) : (
            <EmptyState icon={FileSearchIcon} title="No gateway activity yet" description="Tool calls and admin changes in this time range appear here." />
          )
        }
      />
      <AuditEventDrawer eventId={search.event} onClose={() => patch({ event: undefined })} />
    </Page>
  );
}
