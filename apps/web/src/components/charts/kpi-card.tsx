import type { ReactNode } from 'react';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Whether a change is good or bad depends on the metric, not its direction (§5.4): more calls is
 * neutral, higher success is good, higher error rate / blocked / latency is bad.
 */
export type DeltaSemantics = 'neutral' | 'higher-is-better' | 'lower-is-better';

export interface KpiDelta {
  /** "12.4%" or "0.3 pt" */
  text: string;
  direction: 'up' | 'down' | 'flat';
  tone: 'good' | 'bad' | 'neutral';
}

/**
 * Delta of `current` vs `previous`. Rates (0..1) use percentage points; counts and latencies use
 * relative %. Returns null when there's no previous value to compare with.
 */
export function computeDelta(current: number | null, previous: number | null, semantics: DeltaSemantics, kind: 'count' | 'rate' = 'count'): KpiDelta | null {
  if (current === null || previous === null) return null;
  let value: number;
  let text: string;
  if (kind === 'rate') {
    value = (current - previous) * 100;
    text = `${Math.abs(value).toFixed(1)} pt`;
  } else {
    if (previous === 0) return current === 0 ? { text: '0%', direction: 'flat', tone: 'neutral' } : null;
    value = ((current - previous) / previous) * 100;
    text = `${Math.abs(value).toFixed(1)}%`;
  }
  const direction = Math.abs(value) < 0.05 ? 'flat' : value > 0 ? 'up' : 'down';
  let tone: KpiDelta['tone'] = 'neutral';
  if (direction !== 'flat' && semantics !== 'neutral') {
    const better = semantics === 'higher-is-better' ? direction === 'up' : direction === 'down';
    tone = better ? 'good' : 'bad';
  }
  return { text, direction, tone };
}

const TONE = { good: 'text-success', bad: 'text-destructive', neutral: 'text-muted-foreground' } as const;

export function DeltaText({ delta, vs }: { delta: KpiDelta | null; vs?: string }) {
  if (!delta) return <span className="text-[12.5px] text-muted-foreground">No previous data</span>;
  const Icon = delta.direction === 'up' ? ArrowUpIcon : delta.direction === 'down' ? ArrowDownIcon : null;
  const words = delta.tone === 'good' ? 'better' : delta.tone === 'bad' ? 'worse' : null;
  return (
    <span className="inline-flex items-center gap-1 text-[12.5px] tabular-nums">
      <span className={cn('inline-flex items-center gap-0.5 font-medium', TONE[delta.tone])}>
        {Icon ? <Icon aria-hidden="true" className="size-3" /> : null}
        {delta.direction === 'down' ? '−' : delta.direction === 'up' ? '+' : ''}
        {delta.text}
        {words ? <span className="sr-only"> ({words})</span> : null}
      </span>
      {vs ? <span className="text-muted-foreground">{vs}</span> : null}
    </span>
  );
}

export function KpiCard({ label, value, delta, vs, loading, children, className }: { label: string; value?: ReactNode; delta?: KpiDelta | null; vs?: string; loading?: boolean; children?: ReactNode; className?: string }) {
  return (
    <section aria-label={label} className={cn('flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-4', className)}>
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {loading ? (
        <Skeleton className="h-8 w-24" />
      ) : children ? (
        children
      ) : (
        <>
          <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
          {delta !== undefined ? <DeltaText delta={delta} {...(vs ? { vs } : {})} /> : null}
        </>
      )}
    </section>
  );
}
