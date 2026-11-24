import { useSuspenseQuery } from '@tanstack/react-query';
import { can, isReadOnly, type Capability, type CapabilityResource, type Me } from '@neurouter/shared';
import { meQueryOptions } from '@/features/auth/queries';

/** The signed-in identity (inside the authenticated shell `me` is always loaded by the guard). */
export function useMe(): Me {
  return useSuspenseQuery(meQueryOptions()).data;
}

/** UI permission check (hide/disable only; the API authorizes). */
export function useCan(cap: Capability, resource?: CapabilityResource): boolean {
  return can(useMe(), cap, resource);
}

/** True for Auditors and anyone who can read `read` but not write `write`. */
export function useReadOnly(read: Capability, write: Capability): boolean {
  return isReadOnly(useMe(), read, write);
}
