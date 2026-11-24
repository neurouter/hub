import type { ProxyOptions } from 'vite';

/** Backend-owned prefixes proxied in dev (frontend plan §11; never SPA routes). */
export const PROXIED_PREFIXES = ['/api', '/mcp', '/oauth', '/.well-known', '/metrics'] as const;

/**
 * Vite dev proxy from NEUROUTER_DEV_API_URL (no hardcoded hosts or ports). Throws a readable
 * error when the variable is missing or invalid.
 */
export function buildDevProxy(target: string | undefined): Record<string, ProxyOptions> {
  if (!target || !target.trim()) {
    throw new Error(
      'NEUROUTER_DEV_API_URL is not set. Add it to the repo-root .env (see .env.example), e.g. NEUROUTER_DEV_API_URL=http://<backend host>:<PORT>, then restart `npm run dev`.',
    );
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`NEUROUTER_DEV_API_URL must be an absolute http(s) URL, got "${target}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`NEUROUTER_DEV_API_URL must use http or https, got "${url.protocol}".`);
  const options: ProxyOptions = {
    target: url.origin,
    // keep the browser's Host so the backend sees the Vite origin; forward X-Forwarded-*
    changeOrigin: false,
    xfwd: true,
    ws: false,
  };
  return Object.fromEntries(PROXIED_PREFIXES.map((p) => [p, { ...options }]));
}

/** Optional NEUROUTER_WEB_DEV_PORT; undefined lets Vite pick its default. */
export function parseDevPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`NEUROUTER_WEB_DEV_PORT must be a port number, got "${value}".`);
  return n;
}
