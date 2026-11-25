import { useMemo, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { RefreshCwIcon, StethoscopeIcon } from 'lucide-react';
import { api, can } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Segmented } from '@/components/filters/segmented';
import { PageHeader } from '@/components/layout/page-header';
import { DetailList, Page, Section } from '@/components/layout/section';
import { HealthBadge, Pill, RequestStatusBadge } from '@/components/status/status';
import { GrantsTable } from '@/features/grants/grants-table';
import { CredentialsPanel } from '@/features/servers/credentials-panel';
import { HealthChart } from '@/features/servers/health-chart';
import { serverHealthQuery, serverQuery } from '@/features/servers/queries';
import { ServerSettingsPanel } from '@/features/servers/settings-panel';
import { SyncHistory } from '@/features/servers/sync-history';
import { useHealthCheck, useServerSync } from '@/features/servers/use-sync';
import { BulkReviewDialog } from '@/features/tools/bulk-review-dialog';
import { ToolsTable } from '@/features/tools/tools-table';
import { useMe } from '@/hooks/use-me';
import { useTimeRange } from '@/hooks/use-time-range';
import { apiFetch } from '@/lib/api-client';
import { DASH, formatDate, formatDateTime, formatRelative } from '@/lib/format';
import type { AccessRequest } from '@neurouter/shared';
import { ServerIcon } from '@/components/status/server-icon';

const TABS = ['overview', 'tools', 'auth', 'health', 'access', 'settings'] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute('/_app/admin/servers/$serverId')({
  staticData: { crumbs: ['Administration', 'Servers'], readOnly: { read: 'servers:read', write: 'servers:write' } },
  validateSearch: z.object({ tab: z.enum(TABS).optional().catch(undefined) }),
  beforeLoad: guard(['servers:read']),
  errorComponent: AreaError,
  component: ServerDetailPage,
});

function HealthPanel({ serverId, canCheck, name }: { serverId: string; canCheck: boolean; name: string }) {
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const r = useTimeRange({ range });
  const q = useQuery({ ...serverHealthQuery(serverId, r.from, r.to), placeholderData: keepPreviousData });
  const check = useHealthCheck();
  return (
    <Section
      title="Health"
      actions={
        <>
          <Segmented label="Health range" size="sm" value={range} onChange={setRange} options={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }]} />
          {canCheck ? (
            <Button size="sm" variant="outline" disabled={check.isPending} onClick={() => check.mutate({ id: serverId, name })}>
              {check.isPending ? <Spinner /> : <StethoscopeIcon />} Check now
            </Button>
          ) : null}
        </>
      }
    >
      {q.error ? <ErrorState error={q.error} /> : q.data ? <HealthChart data={q.data} /> : <Skeleton className="h-56 w-full" />}
    </Section>
  );
}

function ServerAccessRequests({ serverId }: { serverId: string }) {
  const q = useQuery({ queryKey: ['access-requests', 'list', { serverId, status: 'pending' }], queryFn: ({ signal }) => apiFetch(api.accessRequests.list, { query: { serverId, status: 'pending', limit: 50 }, signal }) });
  const columns: ColumnSpec<AccessRequest>[] = [
    { id: 'who', header: 'Requester', priority: 1, cell: (r) => r.requester.name },
    { id: 'target', header: 'Target', cell: (r) => <span className="font-mono text-[12.5px]">{r.target.name}</span> },
    { id: 'reason', header: 'Reason', cell: (r) => <span className="line-clamp-1 max-w-md text-muted-foreground">{r.reason}</span> },
    { id: 'status', header: 'Status', cell: (r) => <RequestStatusBadge status={r.status} /> },
    { id: 'when', header: 'Requested', cell: (r) => <span className="text-muted-foreground">{formatRelative(r.createdAt)}</span> },
  ];
  return <DataTable label="Pending access requests" columns={columns} rows={q.data?.items} getRowId={(r) => r.id} loading={q.isLoading} error={q.error} className="rounded-none border-0" empty={<EmptyState title="No pending requests" />} />;
}

function ServerDetailPage() {
  const { serverId } = Route.useParams();
  const { tab = 'overview' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const me = useMe();
  const q = useQuery(serverQuery(serverId));
  const sync = useServerSync();
  const r24 = useTimeRange({ range: '24h' });
  const spark = useQuery({ ...serverHealthQuery(serverId, r24.from, r24.to), enabled: tab === 'overview' });
  const canWrite = can(me, 'servers:write', { serverId });
  const [reviewing, setReviewing] = useState(false);
  const toolFilter = useMemo(() => ({ serverId: [serverId] }), [serverId]);
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  if (!s) return <Skeleton className="h-96 w-full" />;
  return (
    <Page>
      <PageHeader
        title={s.name}
        leading={<ServerIcon server={s} size="lg" />}
        description={s.description || undefined}
        actions={
          canWrite ? (
            <Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate({ id: s.id, name: s.name })}>
              {sync.isPending ? <Spinner /> : <RefreshCwIcon />} Sync now
            </Button>
          ) : undefined
        }
      />
      <div className="-mt-3 flex flex-wrap gap-2">
        <HealthBadge status={s.health.status} latencyMs={s.health.latencyMs} />
        {!s.enabled ? <Pill tone="err">Disabled</Pill> : null}
        {s.trusted ? <Pill tone="info">Trusted</Pill> : null}
        {s.pendingReviewCount ? <Pill tone="warn">{s.pendingReviewCount} pending review</Pill> : null}
        <Pill tone="muted">Owner: {s.owner.name}</Pill>
      </div>
      <Tabs value={tab} onValueChange={(v) => void navigate({ search: { tab: v === 'overview' ? undefined : (v as Tab) }, replace: true })}>
        <TabsList aria-label="Server sections" className="max-w-full overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="auth">Auth &amp; credentials</TabsTrigger>
          <TabsTrigger value="health">Health</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex flex-col gap-5 pt-3">
          <div className="grid gap-5 lg:grid-cols-2">
            <Section title="Status">
              <DetailList
                items={[
                  { label: 'URL', value: <span className="font-mono text-[12.5px] break-all">{s.url}</span> },
                  { label: 'Transport', value: s.transport === 'sse' ? 'SSE (legacy)' : 'Streamable HTTP' },
                  { label: 'Protocol', value: <span className="font-mono text-[12.5px]">{s.protocolVersion ?? DASH}</span> },
                  { label: 'Server info', value: s.serverInfo ? `${s.serverInfo.name} ${s.serverInfo.version}` : DASH },
                  { label: 'Last sync', value: s.lastSyncAt ? formatDateTime(s.lastSyncAt) : 'Never' },
                  { label: 'Tools', value: `${s.enabledToolCount} enabled of ${s.toolCount}` },
                  { label: 'Created', value: formatDate(s.createdAt) },
                ]}
              />
            </Section>
            <Section title="Health · last 24 h" description={s.health.checkedAt ? `Checked ${formatRelative(s.health.checkedAt)}` : undefined}>
              {spark.data ? <HealthChart data={spark.data} sparkline className="h-24" /> : <Skeleton className="h-24 w-full" />}
            </Section>
          </div>
          <Section title="Sync history" description="Tool list syncs: scheduled, manual, and when the server announces changes." bodyClassName="p-0">
            <SyncHistory serverId={s.id} />
          </Section>
        </TabsContent>
        <TabsContent value="tools" className="flex flex-col gap-3 pt-3">
          {s.pendingReviewCount && canWrite ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning-muted px-4 py-2.5">
              <span className="text-[13.5px]">
                {s.pendingReviewCount} {s.pendingReviewCount === 1 ? 'definition is' : 'definitions are'} waiting for review. Those tools are blocked until approved.
              </span>
              <Button size="sm" onClick={() => setReviewing(true)}>
                Review all…
              </Button>
            </div>
          ) : null}
          <BulkReviewDialog serverId={s.id} open={reviewing} onOpenChange={setReviewing} />
          <ToolsTable filter={toolFilter} hideServer empty={<EmptyState title="No tools yet" description="Tools appear after the first sync. They stay disabled until reviewed." />} />
        </TabsContent>
        <TabsContent value="auth" className="pt-3">
          <CredentialsPanel server={s} />
        </TabsContent>
        <TabsContent value="health" className="pt-3">
          <HealthPanel serverId={s.id} name={s.name} canCheck={canWrite} />
        </TabsContent>
        <TabsContent value="access" className="flex flex-col gap-5 pt-3">
          <Section title="Grants on this server" bodyClassName="p-0">
            <GrantsTable filter={{ serverId: s.id }} canWrite={can(me, 'grants:write', { serverId: s.id })} />
          </Section>
          {can(me, 'accessRequests:review', { serverId: s.id }) ? (
            <Section title="Pending access requests" bodyClassName="p-0">
              <ServerAccessRequests serverId={s.id} />
            </Section>
          ) : null}
        </TabsContent>
        <TabsContent value="settings" className="pt-3">
          <ServerSettingsPanel server={s} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
