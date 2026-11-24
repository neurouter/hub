import { useState } from 'react';
import { api, buildPath } from '@neurouter/shared';
import { cn } from '@/lib/utils';

const SIZES = {
  sm: 'size-7 rounded-md text-[11px]',
  md: 'size-9 rounded-lg text-xs',
  lg: 'size-11 rounded-xl text-sm',
} as const;

/**
 * Server icon (frontend §5.1/§5.2, Q9): the backend's same-origin icon proxy
 * (`/api/servers/:id/icon`, never a remote URL, so the strict CSP holds), falling back to the
 * server's initials when there is no icon or it fails to load. Decorative: the name is always
 * rendered next to it.
 */
export function ServerIcon({ server, size = 'md', className }: { server: { id: string; name: string; iconUrl?: string | null | undefined }; size?: keyof typeof SIZES; className?: string }) {
  // `undefined` means the caller has no iconUrl field (e.g. a Ref): try the proxy, which 404s when there is none
  const src = server.iconUrl === undefined ? buildPath(api.servers.icon.path, { id: server.id }) : server.iconUrl;
  const [failed, setFailed] = useState<string | null>(null);
  const showImg = !!src && failed !== src;
  return (
    <span aria-hidden="true" data-slot="server-icon" className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden bg-muted font-bold uppercase', SIZES[size], className)}>
      {showImg ? <img src={src} alt="" loading="lazy" decoding="async" className="size-full object-contain p-1" onError={() => setFailed(src)} /> : server.name.slice(0, 2)}
    </span>
  );
}
