import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindowIcon } from 'lucide-react';
import { api, type OAuthClientRow } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { SearchInput } from '@/components/filters/search-input';
import { Segmented } from '@/components/filters/segmented';
import { Toolbar } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { apiFetch } from '@/lib/api-client';
import { formatDate, formatNumber, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { oauthClientKeys, oauthClientsQuery } from './queries';

type StatusFilter = 'all' | 'active' | 'blocked';
const REGISTRATION: Record<OAuthClientRow['registration'], string> = { cimd: 'Metadata document', dcr: 'Dynamic registration', preregistered: 'Pre-registered' };

/** Host of a redirect URI, for a compact list (full URIs are in the title tooltip). */
export function redirectHosts(uris: readonly string[]): string {
  const hosts = uris.map((u) => {
    try {
      return new URL(u).host || u;
    } catch {
      return u;
    }
  });
  return [...new Set(hosts)].join(', ') || '—';
}

/**
 * OAuth clients (admin/auditor): every MCP client that registered with the gateway's authorization
 * server (CIMD, DCR or pre-registered). Admins can block a client: its tokens stop working and new
 * authorizations are refused; unblocking restores it.
 */
export function OAuthClientsTab({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient();
  const [q, setQ] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<StatusFilter>('all');
  const pager = useCursorStack(`${q ?? ''}|${status}`);
  const list = useQuery({ ...oauthClientsQuery({ q, status: status === 'all' ? undefined : status, cursor: pager.cursor ?? undefined, limit: 50 }), placeholderData: keepPreviousData });
  const [target, setTarget] = useState<OAuthClientRow | null>(null);
  const update = useMutation({
    mutationFn: (c: OAuthClientRow) => apiFetch(api.oauth.updateClient, { params: { id: c.id }, body: { status: c.status === 'active' ? 'blocked' : 'active' } }),
    onSuccess: (c) => {
      notifySuccess(c.status === 'blocked' ? `Blocked ${c.name}` : `Unblocked ${c.name}`);
      setTarget(null);
      void qc.invalidateQueries({ queryKey: oauthClientKeys.all });
    },
    onError: (err) => notifyError(err, 'Could not update the client'),
  });
  const columns: ColumnSpec<OAuthClientRow>[] = [
    {
      id: 'name',
      header: 'Client',
      priority: 1,
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{c.name}</span>
          <span className="truncate font-mono text-[12px] text-muted-foreground" title={c.clientId}>
            {c.clientId}
          </span>
        </span>
      ),
    },
    { id: 'registration', header: 'Registration', cell: (c) => <Pill tone="muted">{REGISTRATION[c.registration]}</Pill> },
    { id: 'redirect', header: 'Redirects to', cell: (c) => <span className="text-muted-foreground" title={c.redirectUris.join('\n')}>{redirectHosts(c.redirectUris)}</span> },
    { id: 'users', header: 'Users', align: 'right', priority: 2, cell: (c) => formatNumber(c.userCount) },
    { id: 'used', header: 'Last used', priority: 2, cell: (c) => <span className="text-muted-foreground">{formatRelative(c.lastUsedAt)}</span> },
    { id: 'created', header: 'Registered', cell: (c) => <span className="text-muted-foreground tabular-nums">{formatDate(c.createdAt)}</span> },
    { id: 'status', header: 'Status', priority: 1, cell: (c) => (c.status === 'blocked' ? <Pill tone="err">Blocked</Pill> : <Pill tone="ok">Active</Pill>) },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (c) =>
        readOnly ? null : (
          <Button variant="ghost" size="sm" className={c.status === 'active' ? 'text-destructive' : undefined} aria-label={`${c.status === 'active' ? 'Block' : 'Unblock'} ${c.name}`} onClick={() => setTarget(c)}>
            {c.status === 'active' ? 'Block' : 'Unblock'}
          </Button>
        ),
    },
  ];
  const blocking = target?.status === 'active';
  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <SearchInput label="Search OAuth clients" placeholder="Search by name or client ID…" value={q} onChange={(v) => setQ(v || undefined)} />
        <Segmented
          label="Client status"
          size="sm"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'blocked', label: 'Blocked' },
          ]}
        />
      </Toolbar>
      <DataTable
        label="OAuth clients"
        columns={columns}
        rows={list.data?.items}
        getRowId={(c) => c.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        empty={<EmptyState icon={AppWindowIcon} title={q || status !== 'all' ? 'No clients match' : 'No OAuth clients yet'} description="Clients appear here when they first register with the gateway, for example Claude Code connecting with OAuth." />}
      />
      <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!list.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor)} total={list.data?.totalEstimate} />
      <ConfirmDialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        destructive={blocking}
        title={blocking ? `Block ${target?.name ?? ''}?` : `Unblock ${target?.name ?? ''}?`}
        description={
          blocking
            ? `Its access tokens stop working and nobody can authorize it again until it is unblocked. ${target?.userCount ?? 0} user(s) are affected.`
            : 'Users can authorize this client again. Tokens issued before the block stay revoked.'
        }
        confirmLabel={blocking ? 'Block client' : 'Unblock client'}
        pending={update.isPending}
        onConfirm={() => target && update.mutate(target)}
      />
    </div>
  );
}
