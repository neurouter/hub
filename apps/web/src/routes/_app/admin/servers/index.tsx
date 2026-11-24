import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { MoreHorizontalIcon, PlusIcon, ServerIcon as ServerGlyph } from 'lucide-react';
import { can, isOwnerScoped, type ServerRow } from '@neurouter/shared';
import { AreaError, guard } from '@/app/route-guards';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { SearchInput } from '@/components/filters/search-input';
import { PageHeader } from '@/components/layout/page-header';
import { Page, Toolbar } from '@/components/layout/section';
import { HealthDot, Pill, healthLabel } from '@/components/status/status';
import { serversListQuery } from '@/features/servers/queries';
import { useHealthCheck, useServerSync } from '@/features/servers/use-sync';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { useMe } from '@/hooks/use-me';
import { formatRelative } from '@/lib/format';
import { ServerIcon } from '@/components/status/server-icon';

export const Route = createFileRoute('/_app/admin/servers/')({
  staticData: { crumbs: ['Administration', 'Servers'], readOnly: { read: 'servers:read', write: 'servers:write' } },
  validateSearch: z.object({ q: z.string().max(200).optional().catch(undefined) }),
  beforeLoad: guard(['servers:read']),
  errorComponent: AreaError,
  component: ServersPage,
});

const AUTH_LABEL: Record<ServerRow['authType'], string> = { none: 'None', shared_bearer: 'Bearer', shared_header: 'Header', per_user_oauth: 'Per-user OAuth' };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ServersPage() {
  const me = useMe();
  const { q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const pager = useCursorStack(q ?? '');
  const list = useQuery({ ...serversListQuery({ q, cursor: pager.cursor ?? undefined, limit: 50 }), placeholderData: keepPreviousData });
  const sync = useServerSync();
  const health = useHealthCheck();
  const owned = isOwnerScoped(me, 'servers:read');
  const columns: ColumnSpec<ServerRow>[] = [
    {
      id: 'name',
      header: 'Server',
      priority: 1,
      cell: (s) => (
        <span className="flex items-center gap-2.5">
          <ServerIcon server={s} size="sm" />
          <span className="flex flex-col">
            <Link to="/admin/servers/$serverId" params={{ serverId: s.id }} className="font-medium underline-offset-4 hover:underline">
              {s.name}
            </Link>
            <span className="font-mono text-xs text-muted-foreground">{s.slug}</span>
          </span>
        </span>
      ),
    },
    { id: 'host', header: 'URL host', cell: (s) => <span className="font-mono text-[12.5px] text-muted-foreground">{hostOf(s.url)}</span> },
    { id: 'transport', header: 'Transport', cell: (s) => (s.transport === 'sse' ? 'SSE (legacy)' : 'Streamable HTTP') },
    { id: 'auth', header: 'Auth', cell: (s) => AUTH_LABEL[s.authType] },
    { id: 'owner', header: 'Owner', priority: 2, cell: (s) => s.owner.name },
    { id: 'trusted', header: 'Trusted', cell: (s) => (s.trusted ? <Pill tone="info">Trusted</Pill> : <span className="text-muted-foreground">—</span>) },
    {
      id: 'health',
      header: 'Health',
      priority: 1,
      cell: (s) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <HealthDot status={s.health.status} />
          {healthLabel(s.health.status, s.health.latencyMs)}
        </span>
      ),
    },
    { id: 'tools', header: 'Tools', align: 'right', priority: 2, cell: (s) => `${s.enabledToolCount} / ${s.toolCount}` },
    { id: 'review', header: 'Pending review', priority: 2, cell: (s) => (s.pendingReviewCount ? <Pill tone="warn">{s.pendingReviewCount} pending</Pill> : <span className="text-muted-foreground">—</span>) },
    { id: 'sync', header: 'Last sync', cell: (s) => <span className="text-muted-foreground">{formatRelative(s.lastSyncAt)}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (s) =>
        can(me, 'servers:write', { serverId: s.id }) ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.name}`} />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => sync.mutate({ id: s.id, name: s.name })}>Sync now</DropdownMenuItem>
              <DropdownMenuItem onClick={() => health.mutate({ id: s.id, name: s.name })}>Check health</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void navigate({ to: '/admin/servers/$serverId', params: { serverId: s.id }, search: { tab: 'settings' } })}>Settings</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ];
  return (
    <Page>
      <PageHeader
        title={owned ? 'My servers' : 'Servers'}
        description={owned ? 'Servers you own. You manage their tools, grants, access requests and approvals.' : 'Upstream MCP servers behind the gateway.'}
        actions={
          can(me, 'servers:create') ? (
            <Button render={<Link to="/admin/servers/new" />}>
              <PlusIcon /> Register server
            </Button>
          ) : undefined
        }
      />
      <Toolbar>
        <SearchInput label="Search servers" value={q} onChange={(v) => void navigate({ search: { q: v } })} />
      </Toolbar>
      <DataTable
        label="Servers"
        columns={columns}
        rows={list.data?.items}
        getRowId={(s) => s.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(s) => void navigate({ to: '/admin/servers/$serverId', params: { serverId: s.id } })}
        empty={
          <EmptyState
            icon={ServerGlyph}
            title={q ? `No servers match “${q}”` : 'No servers yet'}
            description={q ? undefined : 'Register an upstream MCP server to expose its tools through the gateway.'}
            action={!q && can(me, 'servers:create') ? <Button render={<Link to="/admin/servers/new" />}>Register server</Button> : undefined}
          />
        }
      />
      <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!list.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor)} total={list.data?.totalEstimate} />
    </Page>
  );
}
