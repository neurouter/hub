const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function isLoopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Exact redirect URI matching (OAuth 2.1, MCP authorization). The only exception: for a
 * registered loopback `http://127.0.0.1|[::1]|localhost` URI any port is accepted, while
 * scheme, host, path and query still match exactly (native apps, CIMD -03).
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  if (!isLoopbackRedirect(requested)) return false;
  const r = new URL(requested);
  return registered.some((reg) => {
    if (!isLoopbackRedirect(reg)) return false;
    const g = new URL(reg);
    return g.protocol === r.protocol && g.hostname === r.hostname && g.pathname === r.pathname && g.search === r.search && !r.hash;
  });
}

/**
 * Registration-time checks for a redirect URI: absolute, no fragment, https, loopback http,
 * or (native apps) a private-use scheme like `com.example.app:/cb`.
 */
export function validRedirectUri(uri: string, applicationType: 'native' | 'web' | null): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return 'must be an absolute URI';
  }
  if (u.hash || uri.includes('#')) return 'must not contain a fragment';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:') return isLoopbackRedirect(uri) ? null : 'http is only allowed for loopback (127.0.0.1, [::1], localhost)';
  if (['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'].includes(u.protocol)) return 'scheme not allowed';
  if (applicationType === 'web') return 'web clients must use https';
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/i.test(u.protocol) ? null : 'custom schemes must be reverse-domain (e.g. com.example.app:/callback)';
}

/** Appends OAuth response parameters (always including `iss`, RFC 9207). */
export function withParams(redirectUri: string, params: Record<string, string | undefined | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}
