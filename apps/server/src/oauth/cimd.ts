import type { FetchLike } from '../lib/net/safe-fetch.js';
import { validRedirectUri } from './redirect-uri.js';

/** draft-ietf-oauth-client-id-metadata-document-03 (backend §0.3 C5). */
export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 5000;
export const CIMD_MIN_CACHE_MS = 5 * 60_000;
export const CIMD_MAX_CACHE_MS = 24 * 3_600_000;

export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(description);
    this.name = 'OAuthError';
  }
}

/** Whether a client_id should be handled as a Client ID Metadata Document URL. */
export function looksLikeCimd(clientId: string): boolean {
  return /^https:\/\//i.test(clientId);
}

/**
 * client_id URL rules (draft-03 §3): https, a path other than `/`, no fragment, no userinfo,
 * no dot segments. Compared as an exact string: the raw value must already be in normal form.
 */
export function validateClientIdUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'client_id is not a valid URL';
  }
  if (u.protocol !== 'https:') return 'client_id URL must use https';
  if (raw.includes('#')) return 'client_id URL must not contain a fragment';
  if (u.username || u.password || /^https:\/\/[^/]*@/i.test(raw)) return 'client_id URL must not contain userinfo';
  const rawPath = raw.replace(/^https:\/\/[^/?#]*/i, '').split(/[?#]/)[0] ?? '';
  if (!rawPath || rawPath === '/') return 'client_id URL must have a path';
  if (rawPath.split('/').some((seg) => seg === '.' || seg === '..' || /^%2e{1,2}$/i.test(seg))) return 'client_id URL must not contain dot segments';
  if (u.href !== raw) return 'client_id URL must be in normalized form (exact string comparison)';
  return null;
}

export interface ClientMetadata {
  client_id: string;
  client_name: string;
  client_uri: string | null;
  logo_uri: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  application_type: 'native' | 'web' | null;
  raw: Record<string, unknown>;
}

const OUR_GRANTS = ['authorization_code', 'refresh_token'];
const OUR_RESPONSES = ['code'];
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Validates a fetched metadata document against its URL (draft-03 §4). Throws `invalid_client`. */
export function parseClientMetadata(url: string, doc: unknown): ClientMetadata {
  const bad = (msg: string) => new OAuthError('invalid_client', `Client metadata document: ${msg}`);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad('not a JSON object');
  const d = doc as Record<string, unknown>;
  if (d.client_id !== url) throw bad('client_id does not exactly match the document URL');
  for (const k of Object.keys(d)) if (k.startsWith('client_secret')) throw bad(`must not contain ${k}`);
  const method = d.token_endpoint_auth_method ?? 'none';
  if (method === 'private_key_jwt') throw bad('private_key_jwt is not supported');
  if (method !== 'none') throw bad(`token_endpoint_auth_method ${String(method)} is not allowed for metadata-document clients`);
  const name = str(d.client_name);
  if (!name) throw bad('client_name is required');
  if (!Array.isArray(d.redirect_uris) || !d.redirect_uris.length || !d.redirect_uris.every((r) => typeof r === 'string')) throw bad('redirect_uris must be a non-empty array of strings');
  const appType = d.application_type === 'native' || d.application_type === 'web' ? d.application_type : null;
  for (const r of d.redirect_uris as string[]) {
    const err = validRedirectUri(r, appType);
    if (err) throw bad(`redirect_uri ${r} ${err}`);
  }
  const grants = Array.isArray(d.grant_types) ? (d.grant_types as unknown[]).filter((g): g is string => typeof g === 'string') : ['authorization_code'];
  const responses = Array.isArray(d.response_types) ? (d.response_types as unknown[]).filter((g): g is string => typeof g === 'string') : ['code'];
  const grantTypes = grants.filter((g) => OUR_GRANTS.includes(g));
  const responseTypes = responses.filter((r) => OUR_RESPONSES.includes(r));
  if (!grantTypes.includes('authorization_code') || !responseTypes.length) throw bad('grant_types/response_types have no overlap with this server (authorization_code + code)');
  // logo only when served from the client_id host (no third-party images on the consent page)
  const host = new URL(url).host;
  const logo = str(d.logo_uri);
  const sameHost = (u: string | null) => {
    try {
      return !!u && new URL(u).protocol === 'https:' && new URL(u).host === host;
    } catch {
      return false;
    }
  };
  const clientUri = str(d.client_uri);
  return {
    client_id: url,
    client_name: name.slice(0, 200),
    client_uri: clientUri && /^https?:\/\//i.test(clientUri) ? clientUri.slice(0, 2048) : null,
    logo_uri: sameHost(logo) ? logo : null,
    redirect_uris: d.redirect_uris as string[],
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: 'none',
    application_type: appType,
    raw: d,
  };
}

/** Cache lifetime from Cache-Control max-age, clamped to [5 min, 24 h]. */
export function cacheTtlMs(cacheControl: string | null): number {
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl ?? '');
  const noStore = /(?:^|,)\s*(no-store|no-cache)\b/i.test(cacheControl ?? '');
  const ms = noStore ? 0 : m ? Number(m[1]) * 1000 : 0;
  return Math.min(CIMD_MAX_CACHE_MS, Math.max(CIMD_MIN_CACHE_MS, ms));
}

/**
 * Fetches and validates a client metadata document through the strict outbound fetch (SSRF
 * guard): no redirects, non-200 is an error, ~5 KB cap, 5 s timeout. Valid documents are cached
 * per Cache-Control within [5 min, 24 h]; errors are never cached.
 */
export class CimdResolver {
  private readonly cache = new Map<string, { until: number; meta: ClientMetadata }>();

  constructor(
    private readonly fetch: FetchLike,
    private readonly now: () => number,
  ) {}

  async resolve(url: string): Promise<{ meta: ClientMetadata; fetchedAt: number; expiresAt: number }> {
    const hit = this.cache.get(url);
    const now = this.now();
    if (hit && hit.until > now) return { meta: hit.meta, fetchedAt: hit.until - CIMD_MIN_CACHE_MS, expiresAt: hit.until };
    const invalid = validateClientIdUrl(url);
    if (invalid) throw new OAuthError('invalid_client', invalid);
    let res: Response;
    try {
      res = await this.fetch(url, { method: 'GET', redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(CIMD_TIMEOUT_MS) });
    } catch (err) {
      throw new OAuthError('invalid_client', `Could not fetch the client metadata document: ${(err as Error).message}`);
    }
    if (res.status !== 200) throw new OAuthError('invalid_client', `Client metadata document returned HTTP ${res.status} (redirects are not followed)`);
    let text: string;
    try {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > CIMD_MAX_BYTES) throw new Error(`larger than ${CIMD_MAX_BYTES} bytes`);
      text = buf.toString('utf8');
    } catch (err) {
      throw new OAuthError('invalid_client', `Client metadata document rejected: ${(err as Error).message}`);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new OAuthError('invalid_client', 'Client metadata document is not valid JSON');
    }
    const meta = parseClientMetadata(url, doc);
    const until = now + cacheTtlMs(res.headers.get('cache-control'));
    this.cache.set(url, { until, meta });
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
    return { meta, fetchedAt: now, expiresAt: until };
  }
}
