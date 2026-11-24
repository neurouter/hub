import type { Insertable, Kysely } from 'kysely';
import type { OAuthGrantItem } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import { sameResource } from '../auth/mcp/authenticate.js';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB, OauthTokensTable } from '../db/schema.js';
import type { UserSubject } from '../identity/principal.js';
import { AUTH_REVOKED_CHANNEL } from '../identity/users.service.js';
import { toIso, toIsoOrNull, type Clock } from '../lib/clock.js';
import { hmacSha256, randomToken, sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseJsonColumn } from '../lib/json.js';
import { OAuthError } from './cimd.js';
import type { ClientRow } from './clients.service.js';
import { verifyPkceS256 } from './pkce.js';

export const CODE_TTL_MS = 60_000;
export const ACCESS_PREFIX = 'nr_at_';
export const REFRESH_PREFIX = 'nr_rt_';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

/** A stable uuid derived from a hash (the token family of an authorization code). */
export function uuidFromHash(h: Buffer): string {
  const x = Buffer.from(sha256(h).subarray(0, 16));
  x[6] = (x[6]! & 0x0f) | 0x80; // version 8 (custom)
  x[8] = (x[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const s = x.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * Codes and tokens of the gateway AS (backend §7.4 step 7): single-use 60 s codes (reuse revokes
 * every token issued from that code), opaque audience-bound `nr_at_` access tokens and rotating
 * `nr_rt_` refresh tokens (reuse of a rotated refresh token revokes the whole family).
 * Only HMAC(pepper) hashes are stored. Revocations reach every replica via `auth.revoked`.
 */
export class OAuthTokensService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly coord: CoordinationStore,
    private readonly audit: AuditRecorder,
    private readonly o: { pepper: string; resourceUri: string; accessTtlSec: number; refreshTtlDays: number },
  ) {}

  private hash(token: string): Buffer {
    return hmacSha256(this.o.pepper, token);
  }

  async issueCode(input: { clientRowId: string; userId: string; agentId: string; redirectUri: string; codeChallenge: string; scopes: string[]; resource: string }): Promise<string> {
    const code = randomToken(32);
    await this.db
      .insertInto('oauth_codes')
      .values({ code_hash: this.hash(code), client_id: input.clientRowId, user_id: input.userId, agent_id: input.agentId, redirect_uri: input.redirectUri, code_challenge: input.codeChallenge, scopes: input.scopes.join(' '), resource: input.resource, expires_at: this.clock.now() + CODE_TTL_MS, consumed_at: null })
      .execute();
    return code;
  }

  private async mint(input: { clientRowId: string; userId: string; agentId: string; scopes: string; resource: string; familyId: string; parentId: string | null; withRefresh: boolean }): Promise<TokenResponse> {
    const now = this.clock.now();
    const access = `${ACCESS_PREFIX}${randomToken(32)}`;
    const rows: Insertable<OauthTokensTable>[] = [
      { id: newId(), token_hash: this.hash(access), kind: 'access' as const, client_id: input.clientRowId, user_id: input.userId, agent_id: input.agentId, scopes: input.scopes, resource: input.resource, family_id: input.familyId, parent_id: input.parentId, expires_at: now + this.o.accessTtlSec * 1000, revoked_at: null, last_used_at: null, created_at: now },
    ];
    let refresh: string | undefined;
    if (input.withRefresh) {
      refresh = `${REFRESH_PREFIX}${randomToken(32)}`;
      rows.push({ id: newId(), token_hash: this.hash(refresh), kind: 'refresh', client_id: input.clientRowId, user_id: input.userId, agent_id: input.agentId, scopes: input.scopes, resource: input.resource, family_id: input.familyId, parent_id: input.parentId, expires_at: now + this.o.refreshTtlDays * 86_400_000, revoked_at: null, last_used_at: null, created_at: now });
    }
    await this.db.insertInto('oauth_tokens').values(rows).execute();
    return { access_token: access, token_type: 'Bearer', expires_in: this.o.accessTtlSec, ...(refresh ? { refresh_token: refresh } : {}), scope: input.scopes };
  }

  private async revokeFamily(familyId: string, reason: string): Promise<number> {
    const res = await this.db.updateTable('oauth_tokens').set({ revoked_at: this.clock.now() }).where('family_id', '=', familyId).where('revoked_at', 'is', null).executeTakeFirst();
    const n = Number(res.numUpdatedRows);
    if (n) {
      await this.coord.publish(AUTH_REVOKED_CHANNEL, { oauthFamilyId: familyId });
      this.audit.system('oauth.token_family.revoke', { targetType: 'oauth_token_family', targetId: familyId, reason });
    }
    return n;
  }

  /** `grant_type=authorization_code` (PKCE S256, exact redirect_uri, client, resource; single use). */
  async redeemCode(client: ClientRow, p: { code?: string | undefined; redirectUri?: string | undefined; codeVerifier?: string | undefined; resource?: string | undefined }): Promise<TokenResponse> {
    if (!p.code) throw new OAuthError('invalid_request', 'code is required');
    const codeHash = this.hash(p.code);
    const familyId = uuidFromHash(codeHash);
    const now = this.clock.now();
    // atomic single use: only one redemption can flip consumed_at
    const claimed = await this.db.updateTable('oauth_codes').set({ consumed_at: now }).where('code_hash', '=', codeHash).where('consumed_at', 'is', null).executeTakeFirst();
    const row = await this.db.selectFrom('oauth_codes').selectAll().where('code_hash', '=', codeHash).executeTakeFirst();
    if (!row) throw new OAuthError('invalid_grant', 'Unknown authorization code');
    if (!Number(claimed.numUpdatedRows)) {
      await this.revokeFamily(familyId, 'authorization code reused');
      throw new OAuthError('invalid_grant', 'Authorization code already used');
    }
    if (Number(row.expires_at) <= now) throw new OAuthError('invalid_grant', 'Authorization code expired');
    if (row.client_id !== client.id) throw new OAuthError('invalid_grant', 'Authorization code was issued to another client');
    if (!p.redirectUri || p.redirectUri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
    if (!verifyPkceS256(p.codeVerifier, row.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
    if (!p.resource) throw new OAuthError('invalid_target', 'resource is required (RFC 8707)');
    if (!sameResource(p.resource, row.resource) || !sameResource(p.resource, this.o.resourceUri)) throw new OAuthError('invalid_target', 'resource does not match the authorization request');
    const grants = parseJsonColumn<string[]>(client.grant_types) ?? ['authorization_code'];
    const out = await this.mint({ clientRowId: client.id, userId: row.user_id, agentId: row.agent_id, scopes: row.scopes, resource: this.o.resourceUri, familyId, parentId: null, withRefresh: grants.includes('refresh_token') });
    this.audit.auth({ userId: row.user_id, action: 'oauth.token.issue', decision: 'allowed', reason: `client ${client.client_id}` });
    return out;
  }

  /** `grant_type=refresh_token` with rotation; reuse of a rotated token revokes the family. */
  async refresh(client: ClientRow, p: { refreshToken?: string | undefined; resource?: string | undefined; scope?: string | undefined }): Promise<TokenResponse> {
    if (!p.refreshToken) throw new OAuthError('invalid_request', 'refresh_token is required');
    const now = this.clock.now();
    const t = await this.db.selectFrom('oauth_tokens').selectAll().where('token_hash', '=', this.hash(p.refreshToken)).where('kind', '=', 'refresh').executeTakeFirst();
    if (!t) throw new OAuthError('invalid_grant', 'Unknown refresh token');
    if (t.client_id !== client.id) throw new OAuthError('invalid_grant', 'Refresh token was issued to another client');
    if (t.revoked_at !== null) {
      const rotated = await this.db.selectFrom('oauth_tokens').select('id').where('parent_id', '=', t.id).limit(1).executeTakeFirst();
      if (rotated) await this.revokeFamily(t.family_id, 'rotated refresh token reused');
      throw new OAuthError('invalid_grant', 'Refresh token is no longer valid');
    }
    if (Number(t.expires_at) <= now) throw new OAuthError('invalid_grant', 'Refresh token expired');
    if (p.resource && !sameResource(p.resource, this.o.resourceUri)) throw new OAuthError('invalid_target', 'resource does not match');
    if (p.scope) {
      const asked = p.scope.split(/\s+/).filter(Boolean);
      const had = t.scopes.split(/\s+/);
      if (asked.some((s) => !had.includes(s))) throw new OAuthError('invalid_scope', 'A refresh cannot widen the scope');
    }
    const [agent, consent] = await Promise.all([
      this.db.selectFrom('agents').select('status').where('id', '=', t.agent_id).executeTakeFirst(),
      this.db.selectFrom('oauth_consents').select('revoked_at').where('user_id', '=', t.user_id).where('client_id', '=', t.client_id).where('agent_id', '=', t.agent_id).where('revoked_at', 'is', null).executeTakeFirst(),
    ]);
    if (agent?.status !== 'active' || !consent) {
      await this.revokeFamily(t.family_id, 'agent or consent no longer active');
      throw new OAuthError('invalid_grant', 'The authorization was revoked');
    }
    // single-use: only one concurrent refresh can rotate
    const res = await this.db.updateTable('oauth_tokens').set({ revoked_at: now, last_used_at: now }).where('id', '=', t.id).where('revoked_at', 'is', null).executeTakeFirst();
    if (!Number(res.numUpdatedRows)) {
      await this.revokeFamily(t.family_id, 'concurrent refresh token reuse');
      throw new OAuthError('invalid_grant', 'Refresh token is no longer valid');
    }
    const scopes = p.scope ? p.scope.split(/\s+/).filter(Boolean).join(' ') : t.scopes;
    return this.mint({ clientRowId: client.id, userId: t.user_id, agentId: t.agent_id, scopes, resource: t.resource, familyId: t.family_id, parentId: t.id, withRefresh: true });
  }

  /** RFC 7009: refresh token → whole family; access token → that token. Unknown tokens are ignored. */
  async revoke(client: ClientRow, token: string | undefined): Promise<void> {
    if (!token) throw new OAuthError('invalid_request', 'token is required');
    const t = await this.db.selectFrom('oauth_tokens').selectAll().where('token_hash', '=', this.hash(token)).executeTakeFirst();
    if (!t || t.client_id !== client.id) return;
    if (t.kind === 'refresh') {
      await this.revokeFamily(t.family_id, 'revoked by client');
      return;
    }
    await this.db.updateTable('oauth_tokens').set({ revoked_at: this.clock.now() }).where('id', '=', t.id).where('revoked_at', 'is', null).execute();
    await this.coord.publish(AUTH_REVOKED_CHANNEL, { oauthTokenId: t.id });
  }

  /* ---------------------------------------------------------------- authorized apps (portal) */

  async myGrants(viewer: UserSubject, agentId?: string): Promise<{ items: OAuthGrantItem[] }> {
    let qb = this.db
      .selectFrom('oauth_consents as c')
      .innerJoin('oauth_clients as cl', 'cl.id', 'c.client_id')
      .innerJoin('agents as a', 'a.id', 'c.agent_id')
      .select(['c.id', 'c.client_id', 'c.agent_id', 'c.scopes', 'c.created_at', 'cl.client_name', 'cl.client_id as public_client_id', 'a.name as agent_name'])
      .where('c.user_id', '=', viewer.id)
      .where('c.revoked_at', 'is', null)
      .where('a.status', '!=', 'deleted');
    if (agentId) qb = qb.where('c.agent_id', '=', agentId);
    const rows = await qb.orderBy('c.created_at', 'desc').execute();
    const used = rows.length
      ? await this.db
          .selectFrom('oauth_tokens')
          .select(['client_id', 'agent_id', (eb) => eb.fn.max('last_used_at').as('last')])
          .where('user_id', '=', viewer.id)
          .groupBy(['client_id', 'agent_id'])
          .execute()
      : [];
    return {
      items: rows.map((r) => {
        const last = used.find((u) => u.client_id === r.client_id && u.agent_id === r.agent_id)?.last;
        return {
          id: r.id,
          client: { name: r.client_name, id: r.public_client_id },
          agent: { id: r.agent_id, name: r.agent_name },
          scopes: r.scopes.split(/\s+/).filter(Boolean),
          createdAt: toIso(Number(r.created_at)),
          lastUsedAt: toIsoOrNull(last ? Number(last) : null),
        };
      }),
    };
  }

  /** Revokes a consent and every token for (user, client, agent) — on all replicas within the auth cache TTL. */
  async revokeGrant(id: string, viewer: UserSubject): Promise<void> {
    const c = await this.db.selectFrom('oauth_consents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!c || c.user_id !== viewer.id || c.revoked_at !== null) throw AppError.notFound('Authorized app');
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('oauth_consents').set({ revoked_at: now }).where('id', '=', id).execute();
      await trx.updateTable('oauth_tokens').set({ revoked_at: now }).where('user_id', '=', c.user_id).where('client_id', '=', c.client_id).where('agent_id', '=', c.agent_id).where('revoked_at', 'is', null).execute();
    });
    await this.coord.publish(AUTH_REVOKED_CHANNEL, { oauthConsentId: id });
    this.audit.admin({ actorUserId: viewer.id, action: 'oauth_grant.revoke', targetType: 'oauth_consent', targetId: id, before: { clientId: c.client_id, agentId: c.agent_id } });
  }

  /** Housekeeping (job `oauth-cleanup`): expired codes, authorization requests and long-dead tokens. */
  async cleanup(now = this.clock.now()): Promise<{ codes: number; requests: number; tokens: number }> {
    const codes = await this.db.deleteFrom('oauth_codes').where('expires_at', '<', now - 3_600_000).executeTakeFirst();
    const requests = await this.db.deleteFrom('oauth_authz_requests').where('expires_at', '<', now).executeTakeFirst();
    // keep revoked/expired rows for a day so reuse detection still works
    const tokens = await this.db.deleteFrom('oauth_tokens').where('expires_at', '<', now - 86_400_000).executeTakeFirst();
    return { codes: Number(codes.numDeletedRows), requests: Number(requests.numDeletedRows), tokens: Number(tokens.numDeletedRows) };
  }
}
