import { BanIcon, CheckIcon, CircleDashedIcon, LockIcon, MinusIcon } from 'lucide-react';
import type { CatalogServerAccess, CatalogToolAccess } from '@neurouter/shared';
import { Pill } from '@/components/status/status';

export function ServerAccessBadge({ access }: { access: CatalogServerAccess }) {
  if (access === 'granted') return <Pill tone="ok" icon={CheckIcon}>Access granted</Pill>;
  if (access === 'partial') return <Pill tone="info" icon={MinusIcon}>Partial access</Pill>;
  if (access === 'pending') return <Pill tone="warn" icon={CircleDashedIcon}>Requested</Pill>;
  return <Pill tone="muted" icon={LockIcon}>No access</Pill>;
}

export function ToolAccessBadge({ access }: { access: CatalogToolAccess }) {
  if (access === 'allowed') return <Pill tone="ok" icon={CheckIcon}>Allowed</Pill>;
  if (access === 'denied') return <Pill tone="err" icon={BanIcon}>Denied</Pill>;
  if (access === 'pending') return <Pill tone="warn" icon={CircleDashedIcon}>Requested</Pill>;
  return <Pill tone="muted" icon={LockIcon}>No access</Pill>;
}
