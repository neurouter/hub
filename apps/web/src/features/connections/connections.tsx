import { useEffect, useRef, useState } from 'react';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, CheckIcon, ClockIcon, LinkIcon, MinusIcon } from 'lucide-react';
import { api, buildPath, serializeQuery, type Connection, type ConnectionStatus } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Pill, type Tone } from '@/components/status/status';
import { authKeys } from '@/features/auth/queries';
import { catalogKeys } from '@/features/catalog/queries';
import { apiFetch } from '@/lib/api-client';
import { formatDate, formatRelative } from '@/lib/format';
import { browserNavigation } from '@/lib/navigation';
import { notifyError, notifySuccess } from '@/lib/notify';
import { toast } from '@/components/ui/toast';
import { ServerIcon } from '@/components/status/server-icon';

export const connectionKeys = { all: ['me', 'connections'] as const };

export function connectionsQuery() {
  return queryOptions({ queryKey: connectionKeys.all, queryFn: ({ signal }) => apiFetch(api.connections.list, { signal }) });
}

/** Full-page navigation that starts the per-user upstream OAuth (§4.6). */
export function authorizeUrl(serverId: string, returnTo = '/connections'): string {
  return buildPath(api.connections.authorize.path, { serverId }) + serializeQuery({ returnTo });
}

const STATUS: Record<ConnectionStatus, { tone: Tone; icon: typeof CheckIcon; label: (c: Connection) => string }> = {
  connected: { tone: 'ok', icon: CheckIcon, label: (c) => (c.accountLabel ? `Connected as ${c.accountLabel}` : 'Connected') },
  not_connected: { tone: 'muted', icon: MinusIcon, label: () => 'Not connected' },
  expired: { tone: 'warn', icon: ClockIcon, label: () => 'Expired' },
  error: { tone: 'err', icon: AlertCircleIcon, label: () => 'Error' },
};

export function ConnectionStatusPill({ c }: { c: Connection }) {
  const s = STATUS[c.status];
  return (
    <Pill tone={s.tone} icon={s.icon}>
      {s.label(c)}
    </Pill>
  );
}

/** Human text for the `?error=<code>` the backend appends after a failed upstream OAuth round trip. */
export function connectErrorMessage(code: string): string {
  switch (code) {
    case 'access_denied':
      return 'You declined access on the upstream service.';
    case 'state_mismatch':
    case 'invalid_state':
      return 'The sign-in took too long or was started in another tab. Try again.';
    case 'upstream_error':
    case 'server_error':
      return 'The upstream service returned an error. Try again later.';
    default:
      return `The connection failed (${code}).`;
  }
}

/**
 * Connections `/connections` (§5.1): one row per server that uses per-user OAuth, with
 * Connect / Reconnect / Disconnect. Return params (`?connected=` / `?error=&server=`) toast once
 * and are stripped by the route.
 */
export function ConnectionsList({ returned, onConsumed }: { returned: { connected?: string | undefined; error?: string | undefined; server?: string | undefined }; onConsumed: () => void }) {
  const qc = useQueryClient();
  const q = useQuery(connectionsQuery());
  const [confirm, setConfirm] = useState<Connection | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || (!returned.connected && !returned.error) || !q.data) return;
    handled.current = true;
    const id = returned.connected ?? returned.server;
    const name = q.data.items.find((c) => c.server.id === id)?.server.name ?? 'the server';
    if (returned.connected) notifySuccess(`Connected to ${name}`, 'Tools that use your account are ready.');
    else toast.add({ title: `Couldn't connect to ${name}`, description: connectErrorMessage(returned.error!), type: 'error' });
    void qc.invalidateQueries({ queryKey: authKeys.badges });
    onConsumed();
  }, [returned, q.data, qc, onConsumed]);

  const disconnect = useMutation({
    mutationFn: (c: Connection) => apiFetch(api.connections.disconnect, { params: { serverId: c.server.id } }),
    onSuccess: (_r, c) => {
      notifySuccess(`Disconnected from ${c.server.name}`);
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: connectionKeys.all });
      void qc.invalidateQueries({ queryKey: catalogKeys.all });
      void qc.invalidateQueries({ queryKey: authKeys.badges });
    },
    onError: (err) => notifyError(err, 'Could not disconnect'),
  });

  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  const items = q.data?.items ?? [];
  if (items.length === 0) return <EmptyState icon={LinkIcon} title="Nothing to connect" description="None of the servers you can access need a personal account." />;

  return (
    <>
      <ul aria-label="Connections" className="divide-y rounded-xl border bg-card">
        {items.map((c) => {
          const connected = c.status === 'connected';
          return (
            <li key={c.server.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
              <ServerIcon server={c.server} />
              <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{c.server.name}</span>
                  <ConnectionStatusPill c={c} />
                </div>
                <span className="text-[12.5px] text-muted-foreground">
                  {connected && c.connectedAt ? `Connected ${formatRelative(c.connectedAt)}` : null}
                  {c.status === 'expired' && c.expiresAt ? `Expired ${formatDate(c.expiresAt)} · reconnect to keep using its tools` : null}
                  {c.status === 'error' ? (c.error ?? 'The upstream token was rejected') : null}
                  {c.status === 'not_connected' ? 'Connect your account to use this server’s tools' : null}
                  {c.scopes.length ? <span className="font-mono"> · {c.scopes.join(' ')}</span> : null}
                </span>
              </div>
              <div className="flex gap-2">
                {connected ? (
                  <Button variant="outline" size="sm" onClick={() => setConfirm(c)} aria-label={`Disconnect ${c.server.name}`}>
                    Disconnect
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant={connected ? 'ghost' : 'default'}
                  onClick={() => browserNavigation.assign(authorizeUrl(c.server.id))}
                  aria-label={`${c.status === 'not_connected' ? 'Connect' : 'Reconnect'} ${c.server.name}`}
                >
                  {c.status === 'not_connected' ? 'Connect' : 'Reconnect'}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Disconnect ${confirm?.server.name ?? ''}?`}
        description="Agents acting as you lose access to this server's tools until you connect again. Neurouter also asks the upstream service to revoke the token."
        confirmLabel="Disconnect"
        pending={disconnect.isPending}
        onConfirm={() => confirm && disconnect.mutate(confirm)}
      />
    </>
  );
}
