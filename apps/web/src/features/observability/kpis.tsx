import type { MetricsSummary } from '@neurouter/shared';
import { KpiCard, DeltaText, computeDelta } from '@/components/charts/kpi-card';
import { ErrorState } from '@/components/feedback/states';
import { formatDuration, formatNumber, formatPercent } from '@/lib/format';

/** KPI row (§5.4): deltas vs the previous equal period, coloured by good/bad semantics. */
export function KpiRow({ data, loading, error, vs }: { data: MetricsSummary | undefined; loading: boolean; error: unknown; vs: string }) {
  if (error) return <ErrorState error={error} />;
  const d = data;
  const p = d?.previous;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <KpiCard label="Calls" loading={loading} value={formatNumber(d?.calls)} delta={d && p ? computeDelta(d.calls, p.calls, 'neutral') : null} vs={vs} />
      <KpiCard label="Success rate" loading={loading} value={formatPercent(d?.successRate)} delta={d && p ? computeDelta(d.successRate, p.successRate, 'higher-is-better', 'rate') : null} vs={vs} />
      <KpiCard label="Error rate" loading={loading} value={formatPercent(d?.errorRate)} delta={d && p ? computeDelta(d.errorRate, p.errorRate, 'lower-is-better', 'rate') : null} vs={vs} />
      <KpiCard label="Blocked" loading={loading} value={formatNumber(d?.blocked)} delta={d && p ? computeDelta(d.blocked, p.blocked, 'lower-is-better') : null} vs={vs} />
      <KpiCard label="Latency" loading={loading} className="col-span-2 md:col-span-1">
        {d && p ? (
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1">
            {(['p50', 'p95', 'p99'] as const).map((k) => (
              <div key={k} className="contents">
                <dt className="text-[12.5px] text-muted-foreground">{k}</dt>
                <dd className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold tabular-nums">{formatDuration(d.latency[k])}</span>
                  <DeltaText delta={computeDelta(d.latency[k], p.latency[k], 'lower-is-better')} />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </KpiCard>
    </div>
  );
}
