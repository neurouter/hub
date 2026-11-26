import { useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRightIcon, PlugIcon, TriangleAlertIcon } from 'lucide-react';
import type { CatalogServerTool } from '@neurouter/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CopyButton } from '@/components/code/copy-button';
import { JsonViewer } from '@/components/code/json-viewer';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { DetailList, Page, Section } from '@/components/layout/section';
import { HealthBadge, Pill } from '@/components/status/status';
import { myRequestsQuery } from '@/features/access-requests/queries';
import { RequestAccessDialog, type RequestTarget } from '@/features/access-requests/request-access-dialog';
import { ServerAccessBadge, ToolAccessBadge } from '@/features/catalog/access';
import { catalogServerQuery } from '@/features/catalog/queries';
import { ApiError } from '@/lib/api-client';
import { browserNavigation } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { pendingIndex, useCancelRequest } from './index';
import { ServerIcon } from '@/components/status/server-icon';

export const Route = createFileRoute('/_app/catalog/$serverId')({
  staticData: { crumbs: ['Portal', 'Catalog'] },
  component: CatalogServerPage,
});

const AUTH_LABEL = { none: 'No credentials', shared_bearer: 'Shared credentials', shared_header: 'Shared credentials', per_user_oauth: 'Per-user OAuth' } as const;

/** Access counts for the "Your access" card. */
export function accessCounts(tools: CatalogServerTool[]) {
  return {
    allowed: tools.filter((t) => t.access === 'allowed').length,
    approval: tools.filter((t) => t.access === 'allowed' && t.requiresApproval).length,
    denied: tools.filter((t) => t.access === 'denied').length,
    none: tools.filter((t) => t.access === 'none' || t.access === 'pending').length,
  };
}

function ToolItem({ t, onRequest, pending }: { t: CatalogServerTool; onRequest: () => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b last:border-0">
      <div className="flex flex-wrap items-start gap-2 px-3 py-3">
        <Button variant="ghost" size="icon-xs" aria-expanded={open} aria-label={`Toggle schema for ${t.name}`} onClick={() => setOpen((o) => !o)}>
          <ChevronRightIcon className={cn('transition-transform', open && 'rotate-90')} />
        </Button>
        <div className="flex min-w-60 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[13px] font-medium">{t.qualifiedName}</span>
            <CopyButton value={t.qualifiedName} ariaLabel={`Copy ${t.qualifiedName}`} />
            {t.requiresApproval ? <Pill tone="warn">Requires approval</Pill> : null}
            {t.rateLimit ? <Pill tone="muted">{t.rateLimit.perMinute}/min</Pill> : null}
          </div>
          <span className="text-[13px] text-muted-foreground">{t.description}</span>
        </div>
        <div className="flex items-center gap-2">
          <ToolAccessBadge access={pending ? 'pending' : t.access} />
          {t.access === 'none' && !pending ? (
            <Button variant="outline" size="xs" onClick={onRequest} aria-label={`Request ${t.qualifiedName}`}>
              Request
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <div className="flex flex-col gap-2 px-3 pb-3 pl-11">
          <span className="text-[12.5px] text-muted-foreground">Input schema</span>
          <JsonViewer value={t.inputSchema} label={`Input schema of ${t.name}`} collapseAfter={30} />
        </div>
      ) : null}
    </li>
  );
}

/** Catalog server detail (§5.1, prototype ServerDetail): tools with my access, request, connect. */
function CatalogServerPage() {
  const { serverId } = Route.useParams();
  const q = useQuery(catalogServerQuery(serverId));
  const mine = useQuery(myRequestsQuery({ status: 'pending', limit: 200 }));
  const pending = useMemo(() => pendingIndex(mine.data?.items), [mine.data]);
  const cancel = useCancelRequest();
  const [filter, setFilter] = useState('');
  const [requesting, setRequesting] = useState<RequestTarget | null>(null);
  if (q.error) {
    if (q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403)) {
      return <EmptyState title="Server not found or not visible to you" action={<Button variant="outline" render={<Link to="/catalog" />}>Back to catalog</Button>} />;
    }
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const s = q.data;
  if (!s) return <Skeleton className="h-96 w-full" />;
  const counts = accessCounts(s.tools);
  const serverPending = pending.get(s.id);
  const tools = s.tools.filter((t) => !filter || `${t.name} ${t.description}`.toLowerCase().includes(filter.toLowerCase()));
  const needsConnect = s.authType === 'per_user_oauth' && (s.connection === 'not_connected' || s.connection === 'expired');
  const connect = () => browserNavigation.assign(`/api/me/connections/${encodeURIComponent(s.id)}/authorize?returnTo=${encodeURIComponent(`/catalog/${s.id}`)}`);
  return (
    <Page>
      <PageHeader
        title={s.name}
        leading={<ServerIcon server={s} size="lg" />}
        description={s.description}
        actions={
          <>
            {s.access === 'none' || s.access === 'partial' ? (
              serverPending ? (
                <Button variant="outline" onClick={() => cancel.mutate(serverPending)}>
                  Cancel request
                </Button>
              ) : (
                <Button onClick={() => setRequesting({ type: 'server', id: s.id, name: s.name, ownerName: s.owner.name })}>Request access</Button>
              )
            ) : null}
            <Button variant="outline" render={<Link to="/connect" />}>
              <PlugIcon /> Connect a client
            </Button>
          </>
        }
      />
      <div className="-mt-3 flex flex-wrap items-center gap-2">
        <HealthBadge status={s.health.status} />
        <ServerAccessBadge access={serverPending ? 'pending' : s.access} />
        {s.authType === 'per_user_oauth' ? <Pill tone="info">Uses your account</Pill> : null}
        <span className="text-[13px] text-muted-foreground">
          Owner: {s.owner.name}
          {s.tags.length ? ' ·' : ''}
        </span>
        {s.tags.map((t) => (
          <Pill key={t} tone="muted">{t}</Pill>
        ))}
      </div>
      {s.health.status === 'down' ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>This server is down</AlertTitle>
          <AlertDescription>Calls to its tools fail until it recovers. The owner has been notified by the health checks.</AlertDescription>
        </Alert>
      ) : null}
      {needsConnect && s.access !== 'none' ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-info/30 bg-info-muted p-4">
          <div className="flex min-w-72 flex-1 flex-col gap-0.5">
            <span className="font-medium text-info">Connect your {s.name} account to use these tools</span>
            <span className="text-[13.5px]">This server acts as you. Neurouter Hub stores an encrypted token for your account and never passes it to agents. Calls fail with “account not connected” until you connect.</span>
          </div>
          <Button size="sm" onClick={connect}>
            Connect account
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col items-start gap-5 lg:flex-row">
        <Tabs defaultValue="tools" className="w-full min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <TabsList aria-label="Server sections">
              <TabsTrigger value="tools">
                Tools <Pill tone="muted" className="h-5">{s.tools.length}</Pill>
              </TabsTrigger>
              <TabsTrigger value="about">About</TabsTrigger>
            </TabsList>
            <span className="flex-1" />
            <label>
              <span className="sr-only">Filter tools</span>
              <Input type="search" className="h-8 w-56" placeholder={`Filter ${s.tools.length} tools…`} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
          </div>
          <TabsContent value="tools" className="pt-2">
            {tools.length === 0 ? (
              <EmptyState title="No tools match" />
            ) : (
              <ul aria-label="Tools" className="rounded-xl border bg-card">
                {tools.map((t) => (
                  <ToolItem key={t.id} t={t} pending={pending.has(t.id)} onRequest={() => setRequesting({ type: 'tool', id: t.id, name: t.qualifiedName, ownerName: s.owner.name })} />
                ))}
              </ul>
            )}
          </TabsContent>
          <TabsContent value="about" className="pt-2">
            <Section>
              <DetailList
                items={[
                  { label: 'Slug', value: <span className="font-mono text-[12.5px]">{s.slug}</span> },
                  { label: 'Tool names', value: <span className="font-mono text-[12.5px]">{s.slug}__&lt;tool&gt;</span> },
                  { label: 'Owner', value: s.owner.name },
                  { label: 'Upstream auth', value: AUTH_LABEL[s.authType] },
                ]}
              />
            </Section>
          </TabsContent>
        </Tabs>
        <aside className="flex w-full flex-col gap-4 lg:w-72">
          <Section title="Your access">
            <DetailList
              items={[
                { label: 'Allowed', value: <span className="tabular-nums">{counts.allowed}</span> },
                { label: 'Requires approval per call', value: <span className="tabular-nums">{counts.approval}</span> },
                { label: 'Denied', value: <span className="tabular-nums">{counts.denied}</span> },
                { label: 'No access', value: <span className="tabular-nums">{counts.none}</span> },
              ]}
            />
            <p className="mt-3 text-[12.5px] text-muted-foreground">A deny on any of your groups wins over an allow.</p>
          </Section>
          <Section title="Connection">
            <DetailList
              items={[
                { label: 'Upstream auth', value: AUTH_LABEL[s.authType] },
                ...(s.authType === 'per_user_oauth'
                  ? [{ label: 'Your account', value: s.connection === 'connected' ? <Pill tone="ok">Connected</Pill> : s.connection === 'expired' ? <Pill tone="warn">Expired</Pill> : <Pill tone="muted">Not connected</Pill> }]
                  : []),
              ]}
            />
          </Section>
        </aside>
      </div>
      <RequestAccessDialog target={requesting} onOpenChange={(o) => !o && setRequesting(null)} />
    </Page>
  );
}
