import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import { api, type ApiKey } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { KeyStatusBadge } from '@/components/status/status';
import { apiFetch } from '@/lib/api-client';
import { clock } from '@/lib/clock';
import { formatDate, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { agentKeys, agentKeysQuery } from './queries';

const SOON_MS = 14 * 86_400_000;

/**
 * Keys tab: name, prefix, created, expires (amber when < 14 days), last used, status, Revoke.
 * Revoke is optimistic (status → revoked) with rollback on error (§6.2).
 */
export function KeysTable({ agentId, canWrite, onCreate }: { agentId: string; canWrite: boolean; onCreate: () => void }) {
  const qc = useQueryClient();
  const q = useQuery(agentKeysQuery(agentId));
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const revoke = useMutation({
    mutationFn: (k: ApiKey) => apiFetch(api.agents.revokeKey, { params: { id: agentId, keyId: k.id } }),
    onMutate: async (k) => {
      await qc.cancelQueries({ queryKey: agentKeys.keys(agentId) });
      const key = agentKeysQuery(agentId).queryKey;
      const prev = qc.getQueryData(key);
      qc.setQueryData(key, (d) => (d ? { items: d.items.map((x) => (x.id === k.id ? { ...x, status: 'revoked' as const } : x)) } : d));
      setRevoking(null);
      return { prev };
    },
    onError: (err, _k, ctx) => {
      if (ctx?.prev) qc.setQueryData(agentKeysQuery(agentId).queryKey, ctx.prev);
      notifyError(err, 'Could not revoke the key');
    },
    onSuccess: (k) => notifySuccess(`Key “${k.name}” revoked`),
    onSettled: () => void qc.invalidateQueries({ queryKey: agentKeys.detail(agentId) }),
  });
  const now = clock.now();
  const columns: ColumnSpec<ApiKey>[] = [
    { id: 'name', header: 'Name', priority: 1, cell: (k) => <span className="font-medium">{k.name}</span> },
    { id: 'prefix', header: 'Key', priority: 2, cell: (k) => <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12.5px]">{k.prefix}…</span> },
    { id: 'created', header: 'Created', cell: (k) => <span className="text-muted-foreground tabular-nums">{formatDate(k.createdAt)}</span> },
    {
      id: 'expires',
      header: 'Expires',
      priority: 2,
      cell: (k) => {
        const soon = k.status === 'active' && k.expiresAt && Date.parse(k.expiresAt) - now < SOON_MS;
        return <span className={cn('tabular-nums', soon ? 'text-warning' : 'text-muted-foreground')}>{k.status === 'revoked' ? '—' : k.expiresAt ? formatDate(k.expiresAt) : 'Never'}</span>;
      },
    },
    { id: 'used', header: 'Last used', priority: 2, cell: (k) => <span className="text-muted-foreground">{formatRelative(k.lastUsedAt, now)}</span> },
    { id: 'status', header: 'Status', priority: 1, cell: (k) => <KeyStatusBadge status={k.status} /> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (k) =>
        canWrite && k.status === 'active' ? (
          <Button variant="ghost" size="sm" className="text-destructive" aria-label={`Revoke ${k.name}`} onClick={() => setRevoking(k)}>
            Revoke
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      <DataTable
        label="API keys"
        columns={columns}
        rows={q.data?.items}
        getRowId={(k) => k.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={KeyRoundIcon} title="No API keys" description="Create a key for headless agents and CI." action={canWrite ? <Button onClick={onCreate}>Create key</Button> : undefined} />}
      />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke “${revoking?.name ?? ''}”?`}
        description="Revoking breaks any client using it. This cannot be undone."
        confirmLabel="Revoke key"
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </>
  );
}
