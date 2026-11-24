import { useMemo } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { SlidersHorizontalIcon } from 'lucide-react';
import { can, type Session } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Switch } from '@/components/ui/switch';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { EntityPicker } from '@/components/filters/entity-picker';
import { TimeRangePicker } from '@/components/filters/time-range-picker';
import { PageHeader } from '@/components/layout/page-header';
import { Page, Toolbar } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { filterLabels } from '@/features/audit/search';
import { useFilterNames } from '@/features/lookup/names';
import { pickerSearch } from '@/features/pickers';
import { sessionsListQuery } from '@/features/sessions/queries';
import { SOURCE_LABEL } from '@/features/sessions/timeline';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { useMe } from '@/hooks/use-me';
import { useTimeRange } from '@/hooks/use-time-range';
import { formatDuration, formatNumber, formatRelative, formatTime, middleEllipsis } from '@/lib/format';
import { rangeSearchSchema } from '@/lib/time-range';

const search = rangeSearchSchema.extend({
  agentId: z.string().optional().catch(undefined),
  userId: z.string().optional().catch(undefined),
  active: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute('/_app/observability/sessions/')({
  staticData: { crumbs: ['Audit & observability', 'Sessions'] },
  validateSearch: search,
  beforeLoad: guard(['sessions:read']),
  errorComponent: AreaError,
  component: SessionsPage,
});

export function ActiveDot({ active }: { active: boolean }) {
  if (!active) return <span className="text-muted-foreground">Ended</span>;
  return (
    <Pill tone="ok">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-success motion-safe:animate-pulse" />
      Active
    </Pill>
  );
}

function SessionsPage() {
  const me = useMe();
  const s = Route.useSearch();
  useFilterNames([s.agentId, s.userId]);
  const navigate = useNavigate({ from: Route.fullPath });
  const range = useTimeRange(s);
  const set = (p: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...p }) });
  const filter = useMemo(() => ({ from: range.from, to: range.to, agentId: s.agentId, userId: s.userId, ...(s.active ? { active: true } : {}) }), [range.from, range.to, s.agentId, s.userId, s.active]);
  const pager = useCursorStack(JSON.stringify(filter));
  const q = useQuery({
    ...sessionsListQuery({ ...filter, cursor: pager.cursor ?? undefined, limit: 50 }),
    placeholderData: keepPreviousData,
    refetchInterval: s.active ? 10_000 : false,
  });
  const columns: ColumnSpec<Session>[] = [
    { id: 'id', header: 'Session', priority: 1, cell: (x) => (
        <Link to="/observability/sessions/$sessionId" params={{ sessionId: x.id }} aria-label={`Session ${x.id}`} className="font-mono text-[12.5px] underline-offset-4 hover:underline">
          {middleEllipsis(x.id, 8, 4)}
        </Link>
      ) },
    { id: 'source', header: 'Source', cell: (x) => <Pill tone="muted">{SOURCE_LABEL[x.source]}</Pill> },
    { id: 'agent', header: 'Agent', priority: 1, cell: (x) => x.agent.name },
    { id: 'user', header: 'User', priority: 2, cell: (x) => x.user.name },
    { id: 'client', header: 'Client', cell: (x) => <span className="text-muted-foreground">{x.client?.name ?? '—'}</span> },
    { id: 'started', header: 'Started', priority: 2, cell: (x) => <span className="tabular-nums">{formatTime(x.startedAt)}</span> },
    { id: 'last', header: 'Last activity', cell: (x) => <span className="text-muted-foreground">{formatRelative(x.lastActivityAt)}</span> },
    { id: 'duration', header: 'Duration', align: 'right', cell: (x) => formatDuration(Date.parse(x.lastActivityAt) - Date.parse(x.startedAt)) },
    { id: 'calls', header: 'Calls', align: 'right', priority: 2, cell: (x) => formatNumber(x.callCount) },
    { id: 'errors', header: 'Errors', align: 'right', cell: (x) => <span className={x.errorCount ? 'text-destructive' : ''}>{formatNumber(x.errorCount)}</span> },
    { id: 'blocked', header: 'Blocked', align: 'right', cell: (x) => formatNumber(x.blockedCount) },
    { id: 'active', header: 'State', priority: 1, cell: (x) => <ActiveDot active={x.active} /> },
  ];
  const label = (id: string | undefined) => (id ? { id, name: filterLabels.get(id) ?? id.slice(0, 8) } : null);
  return (
    <Page>
      <PageHeader title="Sessions" description="Calls grouped by client session, trace or idle gap." />
      <Toolbar>
        <TimeRangePicker variant="button" value={range} presets={['1h', '6h', '24h', '7d', '30d']} onChange={(r) => set({ range: r.range, from: r.from, to: r.to })} />
        <EntityPicker chip label="Agent" value={label(s.agentId)} onChange={(o) => { if (o) filterLabels.set(o.id, o.name); set({ agentId: o?.id }); }} search={pickerSearch.agents} queryKey={['agents']} />
        {can(me, 'users:read') ? <EntityPicker chip label="User" value={label(s.userId)} onChange={(o) => { if (o) filterLabels.set(o.id, o.name); set({ userId: o?.id }); }} search={pickerSearch.users} queryKey={['users']} /> : null}
        <label className="flex items-center gap-2 text-[13px]">
          <Switch checked={!!s.active} onCheckedChange={(v) => set({ active: v || undefined })} />
          Active only
        </label>
      </Toolbar>
      <DataTable
        label="Sessions"
        columns={columns}
        rows={q.data?.items}
        getRowId={(x) => x.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        onRowClick={(x) => void navigate({ to: '/observability/sessions/$sessionId', params: { sessionId: x.id } })}
        empty={<EmptyState icon={SlidersHorizontalIcon} title={s.active ? 'No active sessions' : 'No sessions in this range'} />}
      />
      <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!q.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(q.data?.nextCursor)} total={q.data?.totalEstimate} />
    </Page>
  );
}
