import { useEffect, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { InfoIcon } from 'lucide-react';
import { can, isOwnerScoped, type Breakdown, type BreakdownDimension, type MetricsFilterQuery } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { EntityPicker } from '@/components/filters/entity-picker';
import { TimeRangePicker } from '@/components/filters/time-range-picker';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { filterLabels } from '@/features/audit/search';
import { useFilterNames } from '@/features/lookup/names';
import { BlockedChart, CallsChart, ChartCard, LatencyChart, SeriesTable, callsSummary, useReducedMotion } from '@/features/observability/charts';
import { KpiRow } from '@/features/observability/kpis';
import { breakdownQuery, summaryQuery, timeseriesQuery } from '@/features/observability/queries';
import { pickerSearch } from '@/features/pickers';
import { useMe } from '@/hooks/use-me';
import { useTimeRange } from '@/hooks/use-time-range';
import { formatDuration, formatNumber, formatPercent, formatTime } from '@/lib/format';
import { PRESET_MS, pickInterval, previousLabel, rangeSearchSchema } from '@/lib/time-range';
import { cn } from '@/lib/utils';

const DIMS = ['server', 'tool', 'agent', 'user'] as const;
type Dim = (typeof DIMS)[number];
const DIM_PARAM: Record<Dim, 'serverId' | 'toolId' | 'agentId' | 'userId'> = { server: 'serverId', tool: 'toolId', agent: 'agentId', user: 'userId' };

const search = rangeSearchSchema.extend({
  serverId: z.string().optional().catch(undefined),
  toolId: z.string().optional().catch(undefined),
  agentId: z.string().optional().catch(undefined),
  userId: z.string().optional().catch(undefined),
  dim: z.enum(DIMS).optional().catch(undefined),
  auto: z.boolean().optional().catch(undefined),
});
type Search = z.infer<typeof search>;

export const Route = createFileRoute('/_app/observability/')({
  staticData: { crumbs: ['Audit & observability', 'Overview'] },
  validateSearch: search,
  beforeLoad: guard(['metrics:read']),
  errorComponent: AreaError,
  component: OverviewPage,
});

/** Auto-refresh defaults to on for ranges ≤ 24 h (§5.4). */
export function autoRefreshDefault(rangeKey: string): boolean {
  return rangeKey !== 'custom' && (PRESET_MS[rangeKey as keyof typeof PRESET_MS] ?? Infinity) <= PRESET_MS['24h'];
}

function BreakdownTable({ data, dim, onFilter }: { data: Breakdown; dim: Dim; onFilter: (key: string, label: string) => void }) {
  const max = Math.max(1, ...data.rows.map((r) => r.calls));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm" aria-label={`Breakdown by ${dim}`}>
        <thead>
          <tr className="border-b text-left text-[12.5px] text-muted-foreground">
            <th className="py-2 font-medium capitalize">{dim}</th>
            <th className="py-2 font-medium">Calls</th>
            <th className="py-2 text-right font-medium">Success</th>
            <th className="py-2 text-right font-medium">Errors</th>
            <th className="py-2 text-right font-medium">p95</th>
            <th className="py-2 text-right font-medium">Blocked</th>
            <th className="py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.key} className="cursor-pointer border-b last:border-0 hover:bg-muted/50" onClick={() => onFilter(r.key, r.label)}>
              <td className={cn('py-2 pr-3', dim === 'tool' && 'font-mono text-[12.5px]')}>{r.label}</td>
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-32 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <div className="h-full rounded-full bg-chart-1" style={{ width: `${(r.calls / max) * 100}%` }} />
                  </div>
                  <span className="tabular-nums">{formatNumber(r.calls)}</span>
                </div>
              </td>
              <td className="py-2 text-right tabular-nums">{formatPercent(r.successRate, 1)}</td>
              <td className={cn('py-2 text-right tabular-nums', (r.errorRate ?? 0) >= 0.03 && 'text-destructive')}>{formatPercent(r.errorRate, 1)}</td>
              <td className="py-2 text-right tabular-nums">{formatDuration(r.p95)}</td>
              <td className="py-2 text-right tabular-nums">{formatNumber(r.blocked)}</td>
              <td className="py-2 text-right">
                <Button variant="ghost" size="xs" aria-label={`Filter by ${r.label}`} onClick={(e) => { e.stopPropagation(); onFilter(r.key, r.label); }}>
                  Filter
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverviewPage() {
  const me = useMe();
  const s = Route.useSearch();
  useFilterNames([s.serverId, s.toolId, s.agentId, s.userId]);
  const navigate = useNavigate({ from: Route.fullPath });
  const range = useTimeRange(s);
  const reduced = useReducedMotion();
  const auto = s.auto ?? autoRefreshDefault(range.key);
  const set = (p: Partial<Search>) => void navigate({ search: (prev) => ({ ...prev, ...p }) });
  const { refresh } = range;
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [auto, refresh]);

  const filter: MetricsFilterQuery = useMemo(
    () => ({ from: range.from, to: range.to, serverId: s.serverId, toolId: s.toolId, agentId: s.agentId, userId: s.userId }),
    [range.from, range.to, s.serverId, s.toolId, s.agentId, s.userId],
  );
  const interval = pickInterval(range.fromMs, range.toMs);
  const summary = useQuery({ ...summaryQuery(filter), placeholderData: keepPreviousData });
  const series = useQuery({ ...timeseriesQuery(filter, interval), placeholderData: keepPreviousData });
  const blocked = useQuery({ ...breakdownQuery(filter, 'block_reason' as BreakdownDimension), placeholderData: keepPreviousData });
  const dim: Dim = s.dim ?? 'server';
  const breakdown = useQuery({ ...breakdownQuery(filter, dim), placeholderData: keepPreviousData });
  const noCalls = summary.data?.calls === 0;

  const chip = (label: string, key: 'serverId' | 'toolId' | 'agentId' | 'userId', searchFn: typeof pickerSearch.servers, qk: string) => (
    <EntityPicker
      chip
      label={label}
      value={s[key] ? { id: s[key]!, name: filterLabels.get(s[key]!) ?? s[key]!.slice(0, 8) } : null}
      onChange={(o) => {
        if (o) filterLabels.set(o.id, o.name);
        set({ [key]: o?.id });
      }}
      search={searchFn}
      queryKey={[qk]}
    />
  );

  return (
    <Page>
      <PageHeader title="Overview" description="Gateway traffic, latency and policy decisions across every server." />
      <div className="flex flex-wrap items-center gap-2">
        <TimeRangePicker value={range} presets={['1h', '6h', '24h', '7d', '30d']} onChange={(r) => set({ range: r.range, from: r.from, to: r.to })} />
        {chip('Server', 'serverId', pickerSearch.servers, 'servers')}
        {chip('Tool', 'toolId', pickerSearch.tools(s.serverId), 'tools')}
        {chip('Agent', 'agentId', pickerSearch.agents, 'agents')}
        {can(me, 'users:read') ? chip('User', 'userId', pickerSearch.users, 'users') : null}
        <span className="flex-1" />
        <label className="flex items-center gap-2 text-[13px]">
          <Switch checked={auto} onCheckedChange={(v) => set({ auto: v })} />
          Auto-refresh 30 s
        </label>
        {summary.dataUpdatedAt ? <span className="text-[13px] text-muted-foreground tabular-nums">Updated {formatTime(summary.dataUpdatedAt)}</span> : null}
      </div>
      {isOwnerScoped(me, 'metrics:read') ? (
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <InfoIcon className="size-3.5" aria-hidden="true" /> Showing traffic for servers you own.
        </p>
      ) : null}
      <KpiRow data={summary.data} loading={summary.isLoading} error={summary.error} vs={previousLabel(range)} />
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Calls over time"
          loading={series.isLoading}
          error={series.error}
          onRetry={() => void series.refetch()}
          empty={noCalls || (series.data?.points.length ?? 0) === 0}
          summary={series.data ? callsSummary(series.data) : ''}
          table={series.data ? <SeriesTable ts={series.data} kind="calls" /> : null}
        >
          {series.data ? <CallsChart ts={series.data} reduced={reduced} /> : null}
        </ChartCard>
        <ChartCard
          title="Latency percentiles"
          loading={series.isLoading}
          error={series.error}
          onRetry={() => void series.refetch()}
          empty={noCalls || (series.data?.points.length ?? 0) === 0}
          summary={summary.data ? `Latency: p50 ${formatDuration(summary.data.latency.p50)}, p95 ${formatDuration(summary.data.latency.p95)}, p99 ${formatDuration(summary.data.latency.p99)}.` : ''}
          table={series.data ? <SeriesTable ts={series.data} kind="latency" /> : null}
        >
          {series.data ? <LatencyChart ts={series.data} reduced={reduced} /> : null}
        </ChartCard>
      </div>
      <ChartCard
        title={
          <>
            Blocked calls by reason{summary.data ? <span className="font-normal text-muted-foreground"> · {formatNumber(summary.data.blocked)} total</span> : null}
          </>
        }
        loading={blocked.isLoading}
        error={blocked.error}
        onRetry={() => void blocked.refetch()}
        empty={(blocked.data?.rows.length ?? 0) === 0}
        summary={blocked.data ? `Blocked calls by reason: ${blocked.data.rows.map((r) => `${r.label} ${formatNumber(r.blocked)}`).join(', ')}.` : ''}
        table={
          blocked.data ? (
            <table className="w-full text-[13px]" aria-label="Blocked calls by reason">
              <tbody>
                {blocked.data.rows.map((r) => (
                  <tr key={r.key} className="border-b last:border-0">
                    <td className="py-1.5">{r.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatNumber(r.blocked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null
        }
      >
        {blocked.data ? <BlockedChart data={blocked.data} reduced={reduced} /> : null}
      </ChartCard>
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[15px] font-semibold">Breakdown</h2>
          <Tabs value={dim} onValueChange={(v) => set({ dim: v === 'server' ? undefined : (v as Dim) })}>
            <TabsList aria-label="Breakdown dimension">
              <TabsTrigger value="server">By server</TabsTrigger>
              <TabsTrigger value="tool">By tool</TabsTrigger>
              <TabsTrigger value="agent">By agent</TabsTrigger>
              {can(me, 'users:read') ? <TabsTrigger value="user">By user</TabsTrigger> : null}
            </TabsList>
          </Tabs>
          <span className="text-[13px] text-muted-foreground">Click a row to add it as a scope filter</span>
        </div>
        {breakdown.error ? (
          <ErrorState error={breakdown.error} onRetry={() => void breakdown.refetch()} />
        ) : breakdown.data && breakdown.data.rows.length === 0 ? (
          <EmptyState title="No calls in this range" />
        ) : breakdown.data ? (
          <BreakdownTable
            data={breakdown.data}
            dim={dim}
            onFilter={(key, label) => {
              filterLabels.set(key, label);
              set({ [DIM_PARAM[dim]]: key });
            }}
          />
        ) : null}
      </section>
    </Page>
  );
}
