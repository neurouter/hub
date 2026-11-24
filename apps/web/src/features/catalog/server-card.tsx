import { Link } from '@tanstack/react-router';
import type { AccessRequest, CatalogServer } from '@neurouter/shared';
import { Button } from '@/components/ui/button';
import { HealthDot, Pill, healthLabel } from '@/components/status/status';
import { ServerAccessBadge } from './access';
import { ServerIcon } from '@/components/status/server-icon';
import { formatNumber } from '@/lib/format';

/** Catalog server card (prototype Catalog.dc.html `.scard`; `compact` = MobileCatalog.dc.html at 375 px). */
export function ServerCard({ s, pending, onRequest, onCancel, onConnect, compact }: { s: CatalogServer; pending?: AccessRequest | undefined; onRequest: () => void; onCancel: (r: AccessRequest) => void; onConnect: () => void; compact?: boolean }) {
  const canRequest = s.access === 'none' || s.access === 'partial';
  const isPending = s.access === 'pending' || !!pending;
  const needsConnection = s.access !== 'none' && (s.connection === 'not_connected' || s.connection === 'expired');
  if (compact) return <CompactServerCard s={s} pending={pending} isPending={isPending} canRequest={canRequest} needsConnection={needsConnection} onRequest={onRequest} onCancel={onCancel} onConnect={onConnect} />;
  return (
    <article className="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-labelledby={`srv-${s.id}`}>
      <div className="flex items-start gap-3">
        <ServerIcon server={s} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <Link id={`srv-${s.id}`} to="/catalog/$serverId" params={{ serverId: s.id }} className="truncate font-semibold underline-offset-4 hover:underline">
              {s.name}
            </Link>
            <HealthDot status={s.health.status} />
            <span className="text-[12.5px] text-muted-foreground">{healthLabel(s.health.status)}</span>
          </div>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {s.slug}__* · {s.owner.name}
          </span>
        </div>
        <ServerAccessBadge access={isPending && s.access !== 'partial' ? 'pending' : s.access} />
      </div>
      <p className="line-clamp-2 text-[13.5px] text-muted-foreground">{s.description}</p>
      <div className="flex flex-wrap gap-1.5">
        {s.tags.map((t) => (
          <Pill key={t} tone="muted">{t}</Pill>
        ))}
        {s.connection === 'not_connected' || s.connection === 'expired' ? <Pill tone="info">Requires account connection</Pill> : null}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-3 text-[13px]">
        <span>
          <span className="font-medium tabular-nums">{formatNumber(s.toolCount)}</span> <span className="text-muted-foreground">{s.toolCount === 1 ? 'tool' : 'tools'}</span>
        </span>
        <span className="flex-1" />
        {isPending ? (
          <>
            <span className="text-muted-foreground">Requested ·</span>
            {pending ? (
              <Button variant="ghost" size="sm" onClick={() => onCancel(pending)}>
                Cancel
              </Button>
            ) : null}
          </>
        ) : canRequest ? (
          <Button size="sm" onClick={onRequest} aria-label={`Request access to ${s.name}`}>
            Request access
          </Button>
        ) : null}
        {!isPending && s.access !== 'none' && (s.connection === 'not_connected' || s.connection === 'expired') ? (
          <Button size="sm" variant="outline" onClick={onConnect}>
            Connect account
          </Button>
        ) : null}
        <Button size="sm" variant="outline" render={<Link to="/catalog/$serverId" params={{ serverId: s.id }} />}>
          View tools
        </Button>
      </div>
    </article>
  );
}

function CompactServerCard({
  s, pending, isPending, canRequest, needsConnection, onRequest, onCancel, onConnect,
}: {
  s: CatalogServer;
  pending?: AccessRequest | undefined;
  isPending: boolean;
  canRequest: boolean;
  needsConnection: boolean;
  onRequest: () => void;
  onCancel: (r: AccessRequest) => void;
  onConnect: () => void;
}) {
  return (
    <article className="flex flex-col gap-2.5 rounded-xl border bg-card p-3.5" aria-labelledby={`srv-${s.id}`}>
      <div className="flex items-center gap-2.5">
        <ServerIcon server={s} className="rounded-[9px] text-[13px]" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <Link id={`srv-${s.id}`} to="/catalog/$serverId" params={{ serverId: s.id }} className="truncate font-semibold">
              {s.name}
            </Link>
            <HealthDot status={s.health.status} />
            <span className="sr-only">{healthLabel(s.health.status)}</span>
          </span>
          <span className="truncate text-[12.5px] text-muted-foreground">
            <span className="tabular-nums">{formatNumber(s.toolCount)}</span> {s.toolCount === 1 ? 'tool' : 'tools'}{s.tags.length ? ` · ${s.tags.join(', ')}` : ''}
          </span>
        </div>
        <ServerAccessBadge access={isPending && s.access !== 'partial' ? 'pending' : s.access} />
      </div>
      <p className="line-clamp-2 text-[13.5px] text-muted-foreground">{s.description}</p>
      {needsConnection || (canRequest && !isPending) || (isPending && pending) ? (
        <div className="flex gap-2">
          {needsConnection && !isPending ? (
            <Button variant="outline" size="lg" className="flex-1" onClick={onConnect}>
              Connect account
            </Button>
          ) : null}
          {canRequest && !isPending ? (
            <Button size="lg" className="flex-1" onClick={onRequest} aria-label={`Request access to ${s.name}`}>
              Request access
            </Button>
          ) : null}
          {isPending && pending ? (
            <Button variant="outline" size="lg" className="flex-1" onClick={() => onCancel(pending)}>
              Cancel request
            </Button>
          ) : null}
          <Button variant="ghost" size="lg" render={<Link to="/catalog/$serverId" params={{ serverId: s.id }} />}>
            Tools
          </Button>
        </div>
      ) : null}
    </article>
  );
}
