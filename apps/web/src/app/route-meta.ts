import type { Capability } from '@neurouter/shared';

/** Per-route static data used by the shell (breadcrumbs, read-only badge). */
export interface AppStaticData {
  /** Breadcrumb trail, e.g. ['Administration', 'Servers'] */
  crumbs?: string[];
  /** Show the "Read-only" badge when the user can read but not write this area (Auditor). */
  readOnly?: { read: Capability; write: Capability };
}

declare module '@tanstack/react-router' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface StaticDataRouteOption extends AppStaticData {}
}
