import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheckIcon } from 'lucide-react';
import { isAdmin, isOwnerScoped } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Page } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { useMe } from '@/hooks/use-me';
import { useIsMobile } from '@/hooks/use-mobile';
import { useNow } from '@/hooks/use-now';
import { serverClock } from '@/lib/server-time';
import { cn } from '@/lib/utils';
import type { LiveStatus } from '@/lib/live';
import { ApprovalCard } from './approval-card';
import { useApprovalEvents, useApprovalsLive } from './live';
import { countdown, crossedThreshold, sortBySoonestExpiry } from './model';
import { POLL_MS, approvalQuery, pendingApprovalsQuery, useDecideApproval } from './queries';
import { RecentDecisions } from './recent-decisions';

const scrollIntoView = (el: HTMLElement | null) => el?.scrollIntoView?.({ block: 'center' });

/** Live / polling indicator (prototype `badge b-ok` with a pulsing dot). */
export function LiveBadge({ status }: { status: LiveStatus }) {
  if (status === 'open')
    return (
      <Pill tone="ok" title="Server-sent events connected">
        <span aria-hidden="true" className="size-[7px] rounded-full bg-success motion-safe:animate-pulse" />
        Live
      </Pill>
    );
  if (status === 'degraded') return <Pill tone="warn" title="The live stream is unavailable; refreshing every 5 seconds">Polling every 5 s</Pill>;
  return <Pill tone="muted">{status === 'paused' ? 'Paused' : 'Connecting…'}</Pill>;
}

/** Polite announcements, at most one per `gapMs` (§8); bursts collapse into a count. */
function useThrottledAnnouncer(gapMs = 5000) {
  const [text, setText] = useState('');
  const last = useRef(0);
  const queued = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const announce = useCallback(
    (msg: string) => {
      const gap = Date.now() - last.current;
      if (gap >= gapMs && !timer.current) {
        last.current = Date.now();
        setText(msg);
        return;
      }
      queued.current.push(msg);
      timer.current ??= setTimeout(() => {
        const q = queued.current;
        queued.current = [];
        timer.current = null;
        last.current = Date.now();
        setText(q.length === 1 ? q[0]! : `${q.length} new approval requests`);
      }, Math.max(0, gapMs - gap));
    },
    [gapMs],
  );
  return { text, announce };
}

/**
 * A linked approval (`?id=`, e.g. from a notification): when it is still in the pending list it is
 * highlighted there; otherwise (resolved, or not loaded yet) it is shown on its own above the list.
 */
function LinkedApproval({ id, inList, compact, now, onClear }: { id: string; inList: boolean; compact: boolean; now: number; onClear: () => void }) {
  const q = useQuery({ ...approvalQuery(id), enabled: !inList });
  const decide = useDecideApproval();
  if (inList) return null;
  if (q.isLoading) return <Skeleton className="h-40 rounded-xl" />;
  return (
    <section aria-label="Linked approval" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-[13.5px] font-medium">Linked approval</h2>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClear}>
          Show all
        </Button>
      </div>
      {q.error ? (
        <p role="alert" className="rounded-lg border p-3 text-[13.5px] text-muted-foreground">
          This approval doesn’t exist or isn’t visible to you.
        </p>
      ) : q.data ? (
        <ApprovalCard
          approval={q.data}
          cd={countdown(q.data.expiresAt, q.data.timeoutSec, now)}
          compact={compact}
          pending={decide.isPending}
          onApprove={() => decide.mutate({ approval: q.data, decision: 'approve' }, { onSettled: () => void q.refetch() })}
          onDeny={(reason) => decide.mutate({ approval: q.data, decision: 'deny', reason }, { onSettled: () => void q.refetch() })}
        />
      ) : null}
    </section>
  );
}

/** `/admin/approvals` (§5.2, prototype Approvals.dc.html + MobileApprovals.dc.html). */
export function ApprovalsPage({ tab, onTab, focusId, onClearFocus }: { tab: 'pending' | 'recent'; onTab: (t: 'pending' | 'recent') => void; focusId?: string | undefined; onClearFocus?: () => void }) {
  const me = useMe();
  const compact = useIsMobile();
  const { status } = useApprovalsLive();
  const q = useQuery({ ...pendingApprovalsQuery(), refetchInterval: status === 'open' ? false : POLL_MS });
  const decide = useDecideApproval();
  const now = serverClock.now(useNow(1000));
  const items = useMemo(() => sortBySoonestExpiry(q.data?.items ?? []), [q.data]);
  const cds = useMemo(() => new Map(items.map((a) => [a.id, countdown(a.expiresAt, a.timeoutSec, now)])), [items, now]);
  const live = useThrottledAnnouncer();
  const [threshold, setThreshold] = useState('');
  const prevLeft = useRef(new Map<string, number>());

  useApprovalEvents((type, a) => {
    if (type === 'approval.created') live.announce(`New approval request for ${a.tool.qualifiedName}`);
  });

  useEffect(() => {
    for (const a of items) {
      const cd = cds.get(a.id);
      if (!cd || a.status !== 'pending') continue;
      const hit = crossedThreshold(prevLeft.current.get(a.id), cd.leftSec);
      if (hit) setThreshold(`${hit === 60 ? '1 minute' : '15 seconds'} left for ${a.tool.qualifiedName}`);
      prevLeft.current.set(a.id, cd.leftSec);
    }
  }, [items, cds]);

  const pendingCount = items.filter((a) => a.status === 'pending' && cds.get(a.id)?.urgency !== 'expired').length;
  const timeoutMin = items[0] ? Math.round(items[0].timeoutSec / 60) : null;
  const ownerScoped = !isAdmin(me) && isOwnerScoped(me, 'approvals:review');

  return (
    <Page>
      <PageHeader
        title="Approvals"
        description="Tool calls held for a human decision. Undecided calls time out and return an error to the agent."
        actions={<LiveBadge status={status} />}
      />
      <div aria-live="polite" className="sr-only">
        {live.text}
      </div>
      <div aria-live="polite" className="sr-only">
        {threshold}
      </div>
      <Tabs value={tab} onValueChange={(v) => onTab(v as 'pending' | 'recent')}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <TabsList aria-label="Approvals">
            <TabsTrigger value="pending">
              Pending
              <span className="ml-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">{pendingCount}</span>
            </TabsTrigger>
            <TabsTrigger value="recent">{compact ? 'Recent' : 'Recent decisions'}</TabsTrigger>
          </TabsList>
          {tab === 'pending' ? (
            <span className="text-[12.5px] text-muted-foreground sm:text-[13px]">
              {ownerScoped ? 'Showing calls to servers you own · soonest expiry first' : 'Sorted by soonest expiry'}
              {timeoutMin && !compact ? ` · timeout ${timeoutMin} min` : ''}
            </span>
          ) : null}
        </div>
        <TabsContent value="pending" className="flex flex-col gap-3.5 pt-3">
          {focusId && !q.isLoading ? <LinkedApproval id={focusId} inList={items.some((a) => a.id === focusId)} compact={compact} now={now} onClear={() => onClearFocus?.()} /> : null}
          {q.error ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : q.isLoading ? (
            <div className="flex flex-col gap-3.5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-56 rounded-xl" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon={ShieldCheckIcon} title="No pending approvals" description="Calls to tools marked “requires approval” will appear here." />
          ) : (
            <ul aria-label="Pending approvals" className={cn('flex flex-col', compact ? 'gap-3' : 'gap-3.5')}>
              {items.map((a) => (
                <li key={a.id} ref={a.id === focusId ? scrollIntoView : undefined} data-focused={a.id === focusId || undefined} className={a.id === focusId ? 'rounded-xl ring-2 ring-ring ring-offset-2 ring-offset-background' : undefined}>
                  <ApprovalCard
                    approval={a}
                    cd={cds.get(a.id)!}
                    compact={compact}
                    pending={decide.isPending && decide.variables?.approval.id === a.id}
                    onApprove={() => decide.mutate({ approval: a, decision: 'approve' })}
                    onDeny={(reason) => decide.mutate({ approval: a, decision: 'deny', reason })}
                  />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="recent" className="pt-3">
          {tab === 'recent' ? <RecentDecisions /> : null}
        </TabsContent>
      </Tabs>
    </Page>
  );
}
