import { useEffect, useMemo, useRef } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { AuditStatusText, DecisionBadge, Pill } from '@/components/status/status';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { AuditEventDrawer } from '@/features/audit/event-drawer';
import { sessionEventsInfinite, sessionQuery } from '@/features/sessions/queries';
import { SOURCE_LABEL, buildTimeline, idleLabel } from '@/features/sessions/timeline';
import { DASH, formatDuration, formatHourMinute, formatNumber, formatOffset, formatTime, middleEllipsis } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ActiveDot } from './index';

export const Route = createFileRoute('/_app/observability/sessions/$sessionId')({
  staticData: { crumbs: ['Audit & observability', 'Sessions'] },
  validateSearch: z.object({ event: z.string().optional().catch(undefined) }),
  beforeLoad: guard(['sessions:read']),
  errorComponent: AreaError,
  component: SessionPage,
});

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-28 flex-col gap-0.5">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

/** Session timeline (§5.4, prototype SessionTimeline): live while active (5 s), click a row for the audit drawer. */
function SessionPage() {
  const { sessionId } = Route.useParams();
  const { event } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const s = useQuery({ ...sessionQuery(sessionId), refetchInterval: (q) => (q.state.data?.active ? 5000 : false) });
  const active = !!s.data?.active;
  const ev = useInfiniteQuery({ ...sessionEventsInfinite(sessionId), refetchInterval: active ? 5000 : false });
  const events = useMemo(() => ev.data?.pages.flatMap((p) => p.items) ?? [], [ev.data]);
  const timeline = useMemo(() => (s.data ? buildTimeline(events, s.data.startedAt) : null), [events, s.data]);
  const endRef = useRef<HTMLDivElement>(null);
  const count = events.length;
  // auto-scroll on new calls only when the user is already at the bottom
  useEffect(() => {
    const el = endRef.current;
    if (!el || !active) return;
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    if (atBottom) el.scrollIntoView({ block: 'end' });
  }, [count, active]);

  if (s.error) return <ErrorState error={s.error} onRetry={() => void s.refetch()} />;
  const d = s.data;
  if (!d) return <Skeleton className="h-96 w-full" />;
  const peak = d.perMinute.reduce((m, p) => (p.calls > m.calls ? p : m), d.perMinute[0] ?? { calls: 0, t: d.startedAt });
  const maxPerMin = Math.max(1, peak.calls);
  return (
    <Page>
      <PageHeader
        title={`Session ${middleEllipsis(d.id, 8, 4)}`}
        description={active ? 'Live · refreshes every 5 s' : `Ended ${formatTime(d.lastActivityAt)}`}
        actions={
          <Button variant="outline" size="sm" render={<Link to="/audit" search={{ sessionId: d.id, range: '7d' }} />}>
            Open in audit log
          </Button>
        }
      />
      <div className="-mt-3 flex flex-wrap gap-2">
        <ActiveDot active={active} />
        <Pill tone="muted">Source: {SOURCE_LABEL[d.source]}</Pill>
      </div>
      <section aria-label="Session summary" className="flex flex-wrap gap-x-8 gap-y-3 rounded-xl border bg-card p-4">
        <Stat label="Agent" value={d.agent.name} />
        <Stat label="User" value={d.user.name} />
        <Stat label="Client" value={d.client?.name ?? DASH} />
        <Stat label="Started" value={formatTime(d.startedAt)} />
        <Stat label="Duration" value={formatDuration(Date.parse(d.lastActivityAt) - Date.parse(d.startedAt))} />
        <Stat label="Calls" value={formatNumber(d.callCount)} />
        <Stat label="Errors" value={formatNumber(d.errorCount)} />
        <Stat label="Blocked" value={formatNumber(d.blockedCount)} />
      </section>
      <section className="flex flex-col gap-2 rounded-xl border bg-card p-4" aria-labelledby="cpm">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 id="cpm" className="text-[15px] font-semibold">Calls per minute</h2>
          {peak.calls ? <span className="text-[13px] text-muted-foreground">peak {peak.calls}/min at {formatHourMinute(peak.t)}</span> : null}
        </div>
        <div role="img" aria-label={`Calls per minute in this session, 0 to ${peak.calls} per minute.`} className="flex h-20 items-end gap-[2px]">
          {d.perMinute.map((p) => (
            <div key={p.t} title={`${formatHourMinute(p.t)}: ${p.calls}`} className="min-w-[3px] flex-1 rounded-t-[3px] bg-chart-1" style={{ height: `${(p.calls / maxPerMin) * 100}%`, minHeight: p.calls ? 2 : 0 }} />
          ))}
        </div>
      </section>
      <section className="flex flex-col rounded-xl border bg-card" aria-labelledby="tl">
        <div className="flex flex-wrap items-baseline gap-2 border-b px-4 py-3">
          <h2 id="tl" className="text-[15px] font-semibold">Timeline</h2>
          <span className="text-[13px] text-muted-foreground">Latency bar scaled to session max ({formatDuration(timeline?.maxLatencyMs ?? 0)}) · click a row for the event detail</span>
        </div>
        {ev.error ? <ErrorState error={ev.error} /> : null}
        {ev.isLoading ? <Skeleton className="m-4 h-40" /> : null}
        {timeline && timeline.items.length === 0 && !ev.isLoading ? <EmptyState title="No calls in this session" /> : null}
        <ol aria-label="Session calls" className="flex flex-col">
          {timeline?.items.map((it) => (
            <li key={`${it.event.auditEventId}-${it.event.ts}`}>
              {it.gapMs ? (
                <div className="flex items-center gap-2 px-4 py-1.5 text-[12.5px] text-muted-foreground" role="separator">
                  <span className="h-px flex-1 border-t border-dashed" />… {idleLabel(it.gapMs)}
                  <span className="h-px flex-1 border-t border-dashed" />
                </div>
              ) : null}
              <div
                className={cn('grid cursor-pointer grid-cols-[5rem_6.5rem_minmax(10rem,1fr)_auto] items-center gap-3 border-b px-4 py-2 hover:bg-muted/50 md:grid-cols-[5rem_6.5rem_minmax(12rem,1fr)_minmax(10rem,auto)_10rem_auto]', event === it.event.auditEventId && 'bg-muted')}
                onClick={() => void navigate({ search: { event: it.event.auditEventId } })}
              >
                <span className="font-mono text-[12.5px] text-muted-foreground tabular-nums">{formatTime(it.event.ts)}</span>
                <span className="font-mono text-[12.5px] tabular-nums">{formatOffset(it.offsetMs)}</span>
                <span className="truncate font-mono text-[12.5px]">{it.event.tool.qualifiedName}</span>
                <span className="hidden flex-wrap items-center gap-1.5 md:flex">
                  <DecisionBadge decision={it.event.decision} />
                  {it.event.status !== 'blocked' ? <AuditStatusText status={it.event.status} /> : null}
                </span>
                <span className="hidden items-center gap-2 md:flex">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span className="block h-full rounded-full bg-chart-1" style={{ width: `${it.latencyPct}%` }} />
                  </span>
                  <span className="w-16 text-right text-[12.5px] tabular-nums">{formatDuration(it.event.latencyMs)}</span>
                </span>
                <Button variant="ghost" size="xs" aria-label={`View event ${it.event.tool.qualifiedName} at ${formatTime(it.event.ts)}`} onClick={(e) => { e.stopPropagation(); void navigate({ search: { event: it.event.auditEventId } }); }}>
                  View
                </Button>
              </div>
            </li>
          ))}
        </ol>
        {ev.hasNextPage ? (
          <div className="flex justify-center p-2">
            <Button variant="ghost" size="sm" disabled={ev.isFetchingNextPage} onClick={() => void ev.fetchNextPage()}>
              Load more
            </Button>
          </div>
        ) : null}
        {active ? (
          <div ref={endRef} className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted-foreground">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-success motion-safe:animate-pulse" />
            Waiting for new calls… auto-scrolls while you're at the bottom
          </div>
        ) : null}
      </section>
      <AuditEventDrawer eventId={event} onClose={() => void navigate({ search: {} })} />
    </Page>
  );
}
