import { useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { TimeRangePicker } from '@/components/filters/time-range-picker';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { RecentActivity } from '@/features/audit/recent-activity';
import { CallsChart, ChartCard, SeriesTable, callsSummary, useReducedMotion } from '@/features/observability/charts';
import { KpiRow } from '@/features/observability/kpis';
import { summaryQuery, timeseriesQuery } from '@/features/observability/queries';
import { useTimeRange } from '@/hooks/use-time-range';
import { pickInterval, previousLabel, rangeSearchSchema } from '@/lib/time-range';

export const Route = createFileRoute('/_app/activity')({
  staticData: { crumbs: ['Portal', 'My activity'] },
  validateSearch: rangeSearchSchema,
  component: ActivityPage,
});

const SCOPE = { scope: 'me' as const };

/** My activity (§5.1): my own calls and stats (scope=me; the backend forces it for plain users, A8). */
function ActivityPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const range = useTimeRange(s);
  const reduced = useReducedMotion();
  const filter = useMemo(() => ({ from: range.from, to: range.to, ...SCOPE }), [range.from, range.to]);
  const summary = useQuery({ ...summaryQuery(filter), placeholderData: keepPreviousData });
  const series = useQuery({ ...timeseriesQuery(filter, pickInterval(range.fromMs, range.toMs)), placeholderData: keepPreviousData });
  return (
    <Page>
      <PageHeader title="My activity" description="Calls made by your agents, and what the gateway decided." />
      <TimeRangePicker value={range} presets={['1h', '24h', '7d', '30d']} onChange={(r) => void navigate({ search: { range: r.range, from: r.from, to: r.to } })} />
      <KpiRow data={summary.data} loading={summary.isLoading} error={summary.error} vs={previousLabel(range)} />
      <ChartCard
        title="Calls over time"
        loading={series.isLoading}
        error={series.error}
        empty={summary.data?.calls === 0 || (series.data?.points.length ?? 0) === 0}
        summary={series.data ? callsSummary(series.data) : ''}
        table={series.data ? <SeriesTable ts={series.data} kind="calls" /> : null}
      >
        {series.data ? <CallsChart ts={series.data} reduced={reduced} /> : null}
      </ChartCard>
      <RecentActivity filter={SCOPE} range={{ range: range.key === 'custom' ? '24h' : range.key, ...(range.key === 'custom' ? { range: 'custom', from: range.from, to: range.to } : {}) }} />
    </Page>
  );
}
