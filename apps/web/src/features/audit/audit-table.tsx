import { useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AuditEvent } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ErrorState } from '@/components/feedback/states';
import { AuditStatusText, DecisionBadge } from '@/components/status/status';
import { DASH, formatDateTime, formatDuration, formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useDisplayPrefs } from '@/lib/display-prefs';

const ROW_HEIGHT = 41;

export interface AuditTableProps {
  rows: AuditEvent[] | undefined;
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  onOpen: (id: string) => void;
  activeId?: string | undefined;
  /** Hide user/client columns (agent activity, my activity). */
  compact?: boolean;
  empty: ReactNode;
  utc?: boolean;
  maxHeight?: string;
}

function toolCell(e: AuditEvent): string {
  return e.tool?.qualifiedName ?? (e.adminAction ? `admin · ${e.adminAction}` : e.kind);
}

/**
 * Audit log table (§5.3): real `<table>` semantics, rows virtualized with @tanstack/react-virtual
 * (spacer rows keep the scroll height), sticky header, "Load more" for the next cursor page.
 * Row click opens the detail drawer; the tool cell is also a focusable button (keyboard / SR).
 */
export function AuditTable({ rows, loading, error, onRetry, hasNextPage, isFetchingNextPage, onLoadMore, onOpen, activeId, compact, empty, utc: utcProp, maxHeight = '70vh' }: AuditTableProps) {
  const prefs = useDisplayPrefs();
  const utc = utcProp ?? prefs.timeDisplay === 'utc';
  const scrollRef = useRef<HTMLDivElement>(null);
  const data = rows ?? [];
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    initialRect: { width: 1200, height: 900 },
  });

  if (error && !rows) return <ErrorState error={error} {...(onRetry ? { onRetry } : {})} />;

  const cols = compact ? 7 : 9;
  const items = virtualizer.getVirtualItems();
  const padTop = items.length ? items[0]!.start : 0;
  const padBottom = items.length ? virtualizer.getTotalSize() - items[items.length - 1]!.end : 0;

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div ref={scrollRef} data-virtual-scroll className="relative overflow-auto" style={{ maxHeight }}>
        <table aria-label="Audit events" aria-busy={loading || undefined} className="w-full min-w-[960px] text-sm">
          <thead className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--border)]">
            <tr className="text-left text-[12.5px] text-muted-foreground">
              <th scope="col" className="h-10 px-3 font-medium whitespace-nowrap">Time ({utc ? 'UTC' : 'local'})</th>
              {compact ? null : <th scope="col" className="px-3 font-medium">User</th>}
              <th scope="col" className="px-3 font-medium">Agent</th>
              {compact ? null : <th scope="col" className="px-3 font-medium">Client</th>}
              <th scope="col" className="px-3 font-medium">Tool</th>
              <th scope="col" className="px-3 font-medium">Decision</th>
              <th scope="col" className="px-3 font-medium">Status</th>
              <th scope="col" className="px-3 text-right font-medium">Latency</th>
              <th scope="col" className="px-3 font-medium">Error</th>
            </tr>
          </thead>
          <tbody>
            {loading && !rows
              ? Array.from({ length: 8 }, (_, i) => (
                  <tr key={i} className="border-b">
                    {Array.from({ length: cols }, (__, j) => (
                      <td key={j} className="px-3 py-3">
                        <Skeleton className="h-4 w-full max-w-32" />
                      </td>
                    ))}
                  </tr>
                ))
              : null}
            {!loading && data.length === 0 ? (
              <tr>
                <td colSpan={cols} className="p-4">
                  {empty}
                </td>
              </tr>
            ) : null}
            {padTop > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={cols} style={{ height: padTop, padding: 0 }} />
              </tr>
            ) : null}
            {items.map((v) => {
              const e = data[v.index]!;
              const active = e.id === activeId;
              return (
                <tr
                  key={e.id}
                  data-index={v.index}
                  aria-selected={active || undefined}
                  onClick={(ev) => {
                    if ((ev.target as HTMLElement).closest('button')) return;
                    onOpen(e.id);
                  }}
                  className={cn('h-[41px] cursor-pointer border-b hover:bg-muted/50', active && 'bg-muted shadow-[inset_3px_0_0_var(--foreground)]')}
                >
                  <td className="px-3 font-mono text-[12.5px] whitespace-nowrap text-muted-foreground tabular-nums" title={formatDateTime(e.ts, { utc: true }) + ' UTC'}>
                    {formatTime(e.ts, { utc })}
                  </td>
                  {compact ? null : <td className="max-w-40 truncate px-3">{e.user?.name ?? DASH}</td>}
                  <td className="max-w-44 truncate px-3">{e.agent?.name ?? DASH}</td>
                  {compact ? null : <td className="max-w-36 truncate px-3 text-muted-foreground">{e.client ? `${e.client.name}${e.client.version ? ` ${e.client.version}` : ''}` : DASH}</td>}
                  <td className="px-3">
                    <button type="button" onClick={() => onOpen(e.id)} className="max-w-72 truncate text-left font-mono text-[12.5px] underline-offset-4 hover:underline">
                      {toolCell(e)}
                    </button>
                  </td>
                  <td className="px-3">
                    <DecisionBadge decision={e.decision} reason={e.decisionReason} />
                  </td>
                  <td className="px-3 whitespace-nowrap">
                    <AuditStatusText status={e.status} />
                  </td>
                  <td className="px-3 text-right whitespace-nowrap tabular-nums">{formatDuration(e.latencyMs)}</td>
                  <td className="max-w-64 truncate px-3 text-muted-foreground" title={e.errorMessage ?? undefined}>
                    {e.errorMessage ?? ''}
                  </td>
                </tr>
              );
            })}
            {padBottom > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={cols} style={{ height: padBottom, padding: 0 }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {hasNextPage || isFetchingNextPage ? (
        <div className="flex justify-center border-t p-2">
          <Button variant="ghost" size="sm" disabled={isFetchingNextPage} onClick={onLoadMore}>
            {isFetchingNextPage ? <Spinner /> : null}
            Load more · newest first
          </Button>
        </div>
      ) : null}
    </div>
  );
}
