import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { LinkIcon } from 'lucide-react';
import type { AuditEventFull } from '@neurouter/shared';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { CopyButton, CopyableMono } from '@/components/code/copy-button';
import { DiffView } from '@/components/code/diff-view';
import { JsonViewer } from '@/components/code/json-viewer';
import { DetailList } from '@/components/layout/section';
import { AuditStatusText, DecisionBadge, Pill } from '@/components/status/status';
import { useIsMobile } from '@/hooks/use-mobile';
import { DASH, formatBytes, formatDateTime, formatDuration, middleEllipsis, shortHash } from '@/lib/format';
import { stableStringify } from '@/lib/json';
import { auditEventQuery } from './queries';

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>;
}

function EventBody({ e }: { e: AuditEventFull }) {
  return (
    <div className="flex flex-col gap-6">
      <DetailList
        items={[
          { label: 'Timestamp', value: <span className="tabular-nums">{formatDateTime(e.ts)} <span className="text-muted-foreground">({formatDateTime(e.ts, { utc: true })}Z)</span></span> },
          { label: 'Event ID', value: <CopyableMono value={e.id} display={middleEllipsis(e.id, 12, 4)} ariaLabel="Copy event ID" /> },
          {
            label: 'User',
            value: e.user ? (
              <Link to="/audit" search={(s) => ({ ...s, userId: e.user!.id, event: undefined })} className="underline-offset-4 hover:underline">
                {e.user.name}
              </Link>
            ) : DASH,
          },
          {
            label: 'Agent',
            value: e.agent ? (
              <Link to="/agents/$agentId" params={{ agentId: e.agent.id }} className="underline-offset-4 hover:underline">
                {e.agent.name}
              </Link>
            ) : DASH,
          },
          { label: 'Client', value: e.client ? `${e.client.name}${e.client.version ? ` ${e.client.version}` : ''}` : DASH },
          { label: 'Decision', value: <span className="flex flex-col gap-0.5"><DecisionBadge decision={e.decision} />{e.decisionReason ? <span className="text-muted-foreground">{e.decisionReason}</span> : null}</span> },
          { label: 'Trace ID', value: e.traceId ? <CopyableMono value={e.traceId} display={middleEllipsis(e.traceId, 16, 5)} ariaLabel="Copy trace ID" /> : DASH },
          {
            label: 'Session',
            value: e.sessionId ? (
              <Link to="/observability/sessions/$sessionId" params={{ sessionId: e.sessionId }} className="font-mono text-[12.5px] underline-offset-4 hover:underline">
                {middleEllipsis(e.sessionId, 8, 4)}
              </Link>
            ) : DASH,
          },
          ...(e.protocolVersion ? [{ label: 'Protocol', value: <span className="font-mono text-[12.5px]">{e.protocolVersion}</span> }] : []),
        ]}
      />
      {e.kind !== 'admin' ? (
        <section className="flex flex-col gap-2">
          <H3>Input parameters</H3>
          {e.inputParams ? <JsonViewer value={e.inputParams} label="Input parameters" collapseAfter={30} /> : <p className="text-muted-foreground">Not recorded</p>}
        </section>
      ) : null}
      {e.kind !== 'admin' ? (
        <section className="flex flex-col gap-2">
          <H3>Output</H3>
          <DetailList
            items={[
              { label: 'Size', value: <span className="tabular-nums">{formatBytes(e.outputSize)}</span> },
              { label: 'SHA-256', value: e.outputHash ? <CopyableMono value={e.outputHash} display={shortHash(e.outputHash)} ariaLabel="Copy output hash" /> : DASH },
              { label: 'Full output', value: e.output !== null && e.output !== undefined ? <JsonViewer value={e.output} collapseAfter={20} /> : <span className="text-muted-foreground">Not stored (setting: outputs as size + hash)</span> },
            ]}
          />
        </section>
      ) : null}
      {e.error ? (
        <section className="flex flex-col gap-2">
          <H3>Error</H3>
          <div className="rounded-lg border border-destructive/30 bg-destructive-muted p-3 text-[13px]">
            <p className="font-medium text-destructive">
              {e.error.code}: {e.error.message}
            </p>
            {e.error.detail ? <pre className="mt-2 font-mono text-xs whitespace-pre-wrap">{e.error.detail}</pre> : null}
          </div>
        </section>
      ) : null}
      {e.admin ? (
        <section className="flex flex-col gap-2">
          <H3>Admin change</H3>
          <DetailList
            items={[
              { label: 'Action', value: <span className="font-mono text-[12.5px]">{e.admin.action}</span> },
              { label: 'Target', value: `${e.admin.target.type} · ${e.admin.target.name}` },
            ]}
          />
          <DiffView oldText={stableStringify(e.admin.before)} newText={stableStringify(e.admin.after)} layout="unified" labels={['Before', 'After']} />
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <H3>Integrity</H3>
        <DetailList
          items={[
            { label: 'Seq', value: <span className="font-mono tabular-nums">{e.seq.toLocaleString('en-US')}</span> },
            { label: 'Hash', value: <CopyableMono value={e.hash} display={shortHash(e.hash)} ariaLabel="Copy hash" /> },
            { label: 'Prev hash', value: <CopyableMono value={e.prevHash} display={shortHash(e.prevHash)} ariaLabel="Copy previous hash" /> },
          ]}
        />
      </section>
    </div>
  );
}

/**
 * Audit event drawer (§5.3), driven by `?event=<id>` so it can be deep-linked. Right Sheet on
 * ≥768 px, bottom sheet on mobile.
 */
export function AuditEventDrawer({ eventId, onClose }: { eventId: string | undefined; onClose: () => void }) {
  const isMobile = useIsMobile();
  const q = useQuery({ ...auditEventQuery(eventId ?? ''), enabled: !!eventId });
  const e = q.data;
  const link = typeof window !== 'undefined' && eventId ? `${window.location.origin}/audit?event=${encodeURIComponent(eventId)}` : '';
  return (
    <Sheet open={!!eventId} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="w-full gap-0 overflow-y-auto data-[side=bottom]:max-h-[85svh] data-[side=right]:sm:max-w-xl">
        <SheetHeader className="gap-2 border-b pr-12">
          <SheetTitle className="font-mono text-[15px] break-all">{e ? (e.tool?.qualifiedName ?? e.adminAction ?? e.kind) : 'Audit event'}</SheetTitle>
          <SheetDescription render={<div />} className="flex flex-wrap items-center gap-1.5">
            {e ? (
              <>
                <DecisionBadge decision={e.decision} reason={e.decisionReason} />
                {e.status !== 'blocked' ? <Pill tone="muted"><AuditStatusText status={e.status} /></Pill> : null}
                {e.latencyMs !== null ? <Pill tone="muted" className="tabular-nums">{formatDuration(e.latencyMs)}</Pill> : null}
                <CopyButton value={link} ariaLabel="Copy link to this event" variant="outline" size="icon-xs" />
                <LinkIcon className="hidden" aria-hidden="true" />
              </>
            ) : null}
          </SheetDescription>
        </SheetHeader>
        <div className="p-4">
          {q.isLoading ? (
            <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading event">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : q.error ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : e ? (
            <EventBody e={e} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
