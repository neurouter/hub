import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import type { HealthHistory } from '@neurouter/shared';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { formatDuration, formatHourMinute } from '@/lib/format';
import { cn } from '@/lib/utils';

const config = { latencyMs: { label: 'Latency', color: 'var(--chart-1)' } } satisfies ChartConfig;

/** Health latency over time (W3). `sparkline` hides axes for the overview card. */
export function HealthChart({ data, sparkline, className }: { data: HealthHistory; sparkline?: boolean; className?: string }) {
  const points = data.points.map((p) => ({ t: Date.parse(p.t), latencyMs: p.latencyMs, status: p.status }));
  const down = data.points.filter((p) => p.status === 'down').length;
  const label = `Health latency, ${points.length} checks${down ? `, ${down} down` : ''}`;
  return (
    <div role="img" aria-label={label} className={cn(sparkline ? 'h-14' : 'h-56', className)}>
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        <LineChart data={points} margin={sparkline ? { top: 4, bottom: 4, left: 0, right: 0 } : { top: 8, left: 4, right: 8 }}>
          {sparkline ? null : <CartesianGrid vertical={false} />}
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} hide={sparkline} tickFormatter={(v: number) => formatHourMinute(v)} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis hide={sparkline} width={56} tickFormatter={(v: number) => formatDuration(v)} tickLine={false} axisLine={false} />
          {sparkline ? null : <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => (p?.[0] ? formatHourMinute(p[0].payload.t as number) : '')} />} />}
          <Line dataKey="latencyMs" type="monotone" stroke="var(--color-latencyMs)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
    </div>
  );
}
