import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import type { EnvelopeService } from '../secrets/envelope.service.js';
import type { SecretProvider } from '../secrets/provider.js';
import { UpstreamError } from './errors.js';

export type AuthMode = 'none' | 'shared' | 'user_oauth';

/** Pool identity of a credential: one pooled client per (server, identity) (backend §6). */
export function credentialIdentity(authMode: AuthMode, userId: string | null): string {
  if (authMode === 'none') return 'none';
  if (authMode === 'shared') return 'shared';
  if (!userId) throw new UpstreamError('connect_required', 'This server needs a per-user connection');
  return `user:${userId}`;
}

export const upstreamTokenAad = (userId: string, serverId: string, field: 'access' | 'refresh') => `neurouter:upstream-token:${userId}:${serverId}:${field}`;

/**
 * Header injection per auth mode (backend §6): none / shared (decrypted server credential,
 * cached 60 s) / user_oauth (the user's own upstream token). Client tokens are never forwarded.
 */
export class CredentialResolver {
  private readonly cache = new Map<string, { at: number; until: number; headers: Record<string, string> }>();
  /** Per-user upstream OAuth refresh (set by the upstream OAuth service, step 10). */
  refresher: ((userId: string, serverId: string) => Promise<unknown>) | null = null;

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly secrets: SecretProvider,
    private readonly envelope: EnvelopeService,
    private readonly clock: Clock,
    private readonly ttlMs = 60_000,
  ) {}

  invalidate(serverId?: string): void {
    if (!serverId) return this.cache.clear();
    for (const k of this.cache.keys()) if (k.startsWith(`${serverId}|`)) this.cache.delete(k);
  }

  async headersFor(server: { id: string; authMode: AuthMode }, userId: string | null): Promise<Record<string, string>> {
    if (server.authMode === 'none') return {};
    const key = `${server.id}|${credentialIdentity(server.authMode, userId)}`;
    const hit = this.cache.get(key);
    const now = this.clock.now();
    if (hit && now - hit.at < this.ttlMs && now < hit.until) return hit.headers;
    const { headers, until } = server.authMode === 'shared' ? { headers: await this.shared(server.id), until: Number.POSITIVE_INFINITY } : await this.userToken(server.id, userId!);
    this.cache.set(key, { at: now, until, headers });
    return headers;
  }

  private async shared(serverId: string): Promise<Record<string, string>> {
    const cred = await this.db.selectFrom('server_credentials').selectAll().where('server_id', '=', serverId).where('kind', 'in', ['shared_bearer', 'shared_header']).executeTakeFirst();
    if (!cred) throw new UpstreamError('auth_required', 'No shared credential is configured for this server');
    const value = (await this.secrets.get({ id: cred.secret_id })).toString('utf8');
    return cred.kind === 'shared_bearer' ? { authorization: `Bearer ${value}` } : { [cred.header_name!.toLowerCase()]: value };
  }

  private async userToken(serverId: string, userId: string): Promise<{ headers: Record<string, string>; until: number }> {
    const load = () => this.db.selectFrom('user_upstream_tokens').selectAll().where('user_id', '=', userId).where('server_id', '=', serverId).executeTakeFirst();
    let row = await load();
    if (!row || row.status !== 'active') throw new UpstreamError('connect_required', row?.status === 'refresh_failed' ? 'Your connection to this server needs to be renewed; reconnect it' : 'Connect your account for this server first');
    // refresh on use when the token expires within 60 s (§7.5)
    if (row.expires_at !== null && Number(row.expires_at) - this.clock.now() <= 60_000 && row.refresh_ct && this.refresher) {
      try {
        await this.refresher(userId, serverId);
      } catch {
        // transient AS failure: fall through and use the current token while it is still valid
      }
      row = await load();
      if (!row || row.status !== 'active') throw new UpstreamError('connect_required', 'Your connection to this server needs to be renewed; reconnect it');
    }
    if (row.expires_at !== null && Number(row.expires_at) <= this.clock.now()) throw new UpstreamError('connect_required', 'Your connection to this server has expired; reconnect it');
    const token = (await this.envelope.open({ dekId: row.dek_id, nonce: row.access_nonce, ciphertext: row.access_ct }, upstreamTokenAad(userId, serverId, 'access'))).toString('utf8');
    const scheme = /^bearer$/i.test(row.token_type) ? 'Bearer' : row.token_type;
    // never serve a cached header past the refresh window
    return { headers: { authorization: `${scheme} ${token}` }, until: row.expires_at === null ? Number.POSITIVE_INFINITY : Number(row.expires_at) - 60_000 };
  }
}
