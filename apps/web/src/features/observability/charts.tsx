import { useState, type ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import type { Breakdown, Timeseries } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { LATENCY_DASH, SERIES_COLOR, callsChartConfig, latencyChartConfig } from '@/components/charts/chart-colors';
import { useMediaQuery } from '@/hooks/use-media-query';
import { formatCompact, formatDateTime, formatDuration, formatHourMinute, formatNumber } from '@/lib/format';

/**
 * Observability widgets (§5.4): each is a card with its own loading/empty/error state, a
 * role="img" summary for screen readers and a "View as table" fallback (§8).
 */
export function ChartCard({ title, extra, table, children, loading, error, onRetry, empty, summary }: { title: ReactNode; extra?: ReactNode; table: ReactNode; children: ReactNode; loading: boolean; error: unknown; onRetry?: () => void; empty: boolean; summary: string }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {extra}
        <span className="flex-1" />
        <Button variant="ghost" size="xs" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'View as chart' : 'View as table'}
        </Button>
      </div>
      {error ? (
        <ErrorState error={error} {...(onRetry ? { onRetry } : {})} />
      ) : loading ? (
        <Skeleton className="h-56 w-full" />
      ) : empty ? (
        <div className="flex h-56 items-center justify-center rounded-lg border border-dashed text-[13px] text-muted-foreground">No calls in this range</div>
      ) : asTable ? (
        <div className="max-h-72 overflow-auto">{table}</div>
      ) : (
        <div role="img" aria-label={summary} className="h-56">
          {children}
        </div>
      )}
    </section>
  );
}

const tick = (v: number) => formatHourMinute(v);

function points(ts: Timeseries | undefined) {
  return (ts?.points ?? []).map((p) => ({ ...p, t: Date.parse(p.t) }));
}

export function callsSummary(ts: Timeseries): string {
  const total = ts.points.reduce((s, p) => s + p.calls, 0);
  const peak = ts.points.reduce((m, p) => (p.calls > m.calls ? p : m), ts.points[0] ?? { calls: 0, t: '' });
  return `Calls over time: ${formatNumber(total)} total${peak.t ? `, peak ${formatNumber(peak.calls)} at ${formatHourMinute(peak.t)}` : ''}.`;
}

/** Calls over time: success (blue) and error (red) only; blocked has its own chart (addendum #2). */
export function CallsChart({ ts, reduced }: { ts: Timeseries; reduced: boolean }) {
  return (
    <ChartContainer config={callsChartConfig} className="aspect-auto h-full w-full">
      <AreaChart data={points(ts)} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={tick} tickLine={false} axisLine={false} minTickGap={48} />
        <YAxis tickFormatter={(v: number) => formatCompact(v)} width={44} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={(_, p) => (p?.[0] ? formatDateTime(p[0].payload.t as number) : '')} />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Area dataKey="success" type="monotone" stackId="calls" stroke="var(--color-success)" fill="var(--color-success)" fillOpacity={0.18} strokeWidth={2} isAnimationActive={!reduced} />
        <Area dataKey="errors" type="monotone" stackId="calls" stroke="var(--color-errors)" fill="var(--color-errors)" fillOpacity={0.3} strokeWidth={2} isAnimationActive={!reduced} />
      </AreaChart>
    </ChartContainer>
  );
}

/** Latency p50/p95/p99: colour plus dash pattern so colour is not the only cue (§7). */
export function LatencyChart({ ts, reduced }: { ts: Timeseries; reduced: boolean }) {
  return (
    <ChartContainer config={latencyChartConfig} className="aspect-auto h-full w-full">
      <LineChart data={points(ts)} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={tick} tickLine={false} axisLine={false} minTickGap={48} />
        <YAxis tickFormatter={(v: number) => formatDuration(v)} width={56} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={(_, p) => (p?.[0] ? formatDateTime(p[0].payload.t as number) : '')} />} />
        <ChartLegend content={<ChartLegendContent />} />
        {(['p50', 'p95', 'p99'] as const).map((k) => (
          <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeDasharray={LATENCY_DASH[k]} strokeWidth={2} dot={false} isAnimationActive={!reduced} />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

const blockedConfig = { blocked: { label: 'Blocked', color: SERIES_COLOR.blocked } } satisfies ChartConfig;

/** Blocked calls by reason (own chart, amber). */
export function BlockedChart({ data, reduced }: { data: Breakdown; reduced: boolean }) {
  return (
    <ChartContainer config={blockedConfig} className="aspect-auto h-full w-full">
      <BarChart data={data.rows} layout="vertical" margin={{ left: 8, right: 24 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="label" width={190} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="blocked" fill="var(--color-blocked)" radius={4} isAnimationActive={!reduced} />
      </BarChart>
    </ChartContainer>
  );
}

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

export function SeriesTable({ ts, kind }: { ts: Timeseries; kind: 'calls' | 'latency' }) {
  return (
    <table className="w-full text-[13px] tabular-nums" aria-label={kind === 'calls' ? 'Calls over time' : 'Latency percentiles'}>
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="py-1.5 font-medium">Time</th>
          {kind === 'calls' ? (
            <>
              <th className="py-1.5 text-right font-medium">Success</th>
              <th className="py-1.5 text-right font-medium">Errors</th>
              <th className="py-1.5 text-right font-medium">Blocked</th>
            </>
          ) : (
            <>
              <th className="py-1.5 text-right font-medium">p50</th>
              <th className="py-1.5 text-right font-medium">p95</th>
              <th className="py-1.5 text-right font-medium">p99</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {ts.points.map((p) => (
          <tr key={p.t} className="border-b last:border-0">
            <td className="py-1">{formatDateTime(p.t)}</td>
            {kind === 'calls' ? (
              <>
                <td className="py-1 text-right">{formatNumber(p.success)}</td>
                <td className="py-1 text-right">{formatNumber(p.errors)}</td>
                <td className="py-1 text-right">{formatNumber(p.blocked)}</td>
              </>
            ) : (
              <>
                <td className="py-1 text-right">{formatDuration(p.p50)}</td>
                <td className="py-1 text-right">{formatDuration(p.p95)}</td>
                <td className="py-1 text-right">{formatDuration(p.p99)}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
