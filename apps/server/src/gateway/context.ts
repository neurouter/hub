import type { McpPrincipal } from '../auth/mcp/authenticate.js';

/** Per-HTTP-request context handed to the SDK factory through `authInfo.extra` (backend §5.1). */
export interface RequestContext {
  principal: McpPrincipal;
  ip: string;
  userAgent: string | null;
  /** HTTP `traceparent` header (session derivation step 2 fallback). */
  traceparent: string | null;
  /** Legacy `Mcp-Session-Id` header when the client sends one (C3). */
  legacySessionId: string | null;
  /** Legacy-era clientInfo remembered from this credential's `initialize` (stateless `/mcp`). */
  legacyClient?: { name: string | null; version: string | null; protocolVersion: string | null } | null;
}

export const RC_KEY = 'neurouter.rc';

/** W3C traceparent → trace id. */
export function traceIdOf(traceparent: string | null | undefined): string | null {
  const m = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/.exec(traceparent?.trim().toLowerCase() ?? '');
  return m && !/^0+$/.test(m[1]!) ? m[1]! : null;
}
