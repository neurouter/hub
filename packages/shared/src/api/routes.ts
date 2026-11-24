import { accessRequestEndpoints } from './access-requests.js';
import { agentEndpoints } from './agents.js';
import { approvalEndpoints } from './approvals.js';
import { auditEndpoints } from './audit.js';
import { authEndpoints } from './auth.js';
import { catalogEndpoints } from './catalog.js';
import { connectionEndpoints } from './connections.js';
import type { EndpointDef } from './endpoint.js';
import { grantEndpoints } from './grants.js';
import { groupEndpoints } from './groups.js';
import { meEndpoints } from './me.js';
import { metricsEndpoints } from './metrics.js';
import { oauthEndpoints } from './oauth.js';
import { portalEndpoints } from './portal.js';
import { redactionEndpoints } from './redaction.js';
import { serverEndpoints } from './servers.js';
import { sessionEndpoints } from './sessions.js';
import { settingsEndpoints } from './settings.js';
import { jobEndpoints, systemEndpoints } from './system.js';
import { toolEndpoints } from './tools.js';
import { userEndpoints } from './users.js';

/**
 * The complete Phase 1 REST contract (backend plan §14.3, reconciled with frontend §9 and both addenda).
 * Server routes and the web client (and MSW handlers) are built from this registry.
 */
export const api = {
  auth: authEndpoints,
  me: meEndpoints,
  portal: portalEndpoints,
  jobs: jobEndpoints,
  system: systemEndpoints,
  oauth: oauthEndpoints,
  catalog: catalogEndpoints,
  accessRequests: accessRequestEndpoints,
  connections: connectionEndpoints,
  agents: agentEndpoints,
  users: userEndpoints,
  groups: groupEndpoints,
  servers: serverEndpoints,
  tools: toolEndpoints,
  grants: grantEndpoints,
  approvals: approvalEndpoints,
  audit: auditEndpoints,
  metrics: metricsEndpoints,
  sessions: sessionEndpoints,
  settings: settingsEndpoints,
  redaction: redactionEndpoints,
} as const;

export type Api = typeof api;
export type ApiArea = keyof Api;

export interface NamedEndpoint {
  /** `<area>.<name>`, e.g. `servers.get` */
  key: string;
  def: EndpointDef;
}

/** Flat list of every endpoint, in registry order. */
export const ALL_ENDPOINTS: readonly NamedEndpoint[] = Object.entries(api).flatMap(([area, defs]) =>
  Object.entries(defs as Record<string, EndpointDef>).map(([name, def]) => ({ key: `${area}.${name}`, def })),
);

/** Path prefixes owned by the backend; they never fall back to the SPA (backend §14.3, frontend §9.12). */
export const NON_SPA_PREFIXES = ['/api', '/mcp', '/oauth', '/.well-known', '/metrics', '/healthz', '/readyz', '/health'] as const;

export function isNonSpaPath(pathname: string): boolean {
  return NON_SPA_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`));
}

/** Non-API backend paths (for completeness, used by dev proxy and static fallback rules). */
export const BACKEND_PATHS = {
  mcp: '/mcp',
  prm: '/.well-known/oauth-protected-resource',
  prmMcp: '/.well-known/oauth-protected-resource/mcp',
  asMetadata: '/.well-known/oauth-authorization-server',
  oidcAlias: '/.well-known/openid-configuration',
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
  revoke: '/oauth/revoke',
  clientMetadata: '/oauth/client-metadata.json',
  upstreamCallback: '/oauth/upstream/callback',
  healthz: '/healthz',
  readyz: '/readyz',
  metrics: '/metrics',
} as const;

/** SPA routes the backend redirects to. */
export const SPA_PATHS = {
  login: '/auth/login',
  loggedOut: '/auth/logged-out',
  consent: '/auth/consent',
  connections: '/connections',
} as const;
