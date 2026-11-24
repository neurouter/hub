import { sql, type Kysely, type Selectable } from 'kysely';
import type { OAuthClientRow } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB, OauthClientsTable } from '../db/schema.js';
import type { UserSubject } from '../identity/principal.js';
import { AUTH_REVOKED_CHANNEL } from '../identity/users.service.js';
import { toIso, toIsoOrNull, type Clock } from '../lib/clock.js';
import { hmacSha256, randomToken, timingSafeEqualBuf } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../lib/json.js';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination.js';
import type { SettingsService } from '../settings/settings.service.js';
import { looksLikeCimd, OAuthError, type CimdResolver } from './cimd.js';
import { validRedirectUri } from './redirect-uri.js';

export type ClientRow = Selectable<OauthClientsTable>;

export interface ResolvedClient {
  row: ClientRow;
  redirectUris: string[];
  grantTypes: string[];
}

const DCR_PREFIX = 'nr_dcr_';

/** RFC 7591 registration request (subset we honour). */
export interface DcrRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  client_uri?: unknown;
  logo_uri?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
  application_type?: unknown;
  scope?: unknown;
  [k: string]: unknown;
}

/**
 * OAuth clients of the gateway AS (backend §7.4): CIMD documents (fetched, validated, cached and
 * mirrored into `oauth_clients` so tokens and agents can reference a row), DCR registrations
 * (RFC 7591, deprecated but kept) and pre-registered clients; admin listing and blocking.
 */
export class OAuthClientsService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly cimd: CimdResolver,
    private readonly settings: SettingsService,
    private readonly pepper: string,
    private readonly audit: AuditRecorder,
    private readonly coord: CoordinationStore,
  ) {}

  static view(row: ClientRow): ResolvedClient {
    return {
      row,
      redirectUris: parseJsonColumn<string[]>(row.redirect_uris) ?? [],
      grantTypes: parseJsonColumn<string[]>(row.grant_types) ?? ['authorization_code'],
    };
  }

  async byRowId(id: string): Promise<ClientRow | undefined> {
    return this.db.selectFrom('oauth_clients').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async byClientId(clientId: string): Promise<ClientRow | undefined> {
    return this.db.selectFrom('oauth_clients').selectAll().where('client_id', '=', clientId).executeTakeFirst();
  }

  /**
   * Resolves the `client_id` of an authorization request. https URLs are CIMD (policy check,
   * fetch, validate, upsert); anything else must be a DCR / pre-registered row. Blocked clients
   * and unknown ids throw `invalid_client` (shown as an error page, never redirected).
   */
  async resolve(clientId: string): Promise<ResolvedClient> {
    if (!clientId || clientId.length > 2048) throw new OAuthError('invalid_client', 'client_id is missing or too long');
    if (looksLikeCimd(clientId)) {
      const policy = await this.settings.get('cimdPolicy');
      const host = new URL(clientId).hostname.toLowerCase();
      if (policy.mode === 'allowlist' && !policy.allowedHosts.some((h) => h.toLowerCase() === host || host.endsWith(`.${h.toLowerCase()}`))) {
        throw new OAuthError('invalid_client', `Clients from ${host} are not allowed on this gateway`);
      }
      const existing = await this.byClientId(clientId);
      if (existing?.status === 'blocked') throw new OAuthError('invalid_client', 'This client has been blocked by an administrator');
      const { meta, fetchedAt, expiresAt } = await this.cimd.resolve(clientId);
      const now = this.clock.now();
      const values = {
        client_name: meta.client_name,
        client_uri: meta.client_uri,
        logo_uri: meta.logo_uri,
        redirect_uris: toJsonColumn(meta.redirect_uris),
        grant_types: toJsonColumn(meta.grant_types),
        response_types: toJsonColumn(meta.response_types),
        token_endpoint_auth_method: 'none' as const,
        application_type: meta.application_type,
        metadata: toJsonColumn(meta.raw),
        metadata_fetched_at: fetchedAt,
        metadata_expires_at: expiresAt,
        updated_at: now,
      };
      if (existing) {
        await this.db.updateTable('oauth_clients').set(values).where('id', '=', existing.id).execute();
      } else {
        await this.db
          .insertInto('oauth_clients')
          .values({ id: newId(), client_id: clientId, registration_type: 'cimd', client_secret_hash: null, status: 'active', created_at: now, ...values })
          .onConflict((oc) => oc.column('client_id').doUpdateSet(values))
          .execute();
      }
      return OAuthClientsService.view((await this.byClientId(clientId))!);
    }
    const row = await this.byClientId(clientId);
    if (!row) throw new OAuthError('invalid_client', 'Unknown client_id');
    if (row.status === 'blocked') throw new OAuthError('invalid_client', 'This client has been blocked by an administrator');
    return OAuthClientsService.view(row);
  }

  /**
   * Token / revocation endpoint client authentication: `none` (public), `client_secret_basic`
   * or `client_secret_post`. Throws `invalid_client` (401).
   */
  async authenticate(input: { clientId?: string | undefined; basic?: { id: string; secret: string } | null; postSecret?: string | undefined }): Promise<ClientRow> {
    const clientId = input.basic?.id ?? input.clientId;
    if (!clientId) throw new OAuthError('invalid_client', 'client authentication is required', 401);
    if (input.basic && input.clientId && input.clientId !== input.basic.id) throw new OAuthError('invalid_client', 'client_id does not match the authenticated client', 401);
    const row = await this.byClientId(clientId);
    if (!row) throw new OAuthError('invalid_client', 'Unknown client', 401);
    if (row.status === 'blocked') throw new OAuthError('invalid_client', 'This client has been blocked', 401);
    const method = row.token_endpoint_auth_method;
    if (method === 'none') {
      if (input.basic?.secret || input.postSecret) throw new OAuthError('invalid_client', 'This is a public client; do not send a client secret', 401);
      return row;
    }
    const secret = method === 'client_secret_basic' ? input.basic?.secret : method === 'client_secret_post' ? input.postSecret : undefined;
    if (!secret || !row.client_secret_hash || !timingSafeEqualBuf(hmacSha256(this.pepper, secret), row.client_secret_hash)) throw new OAuthError('invalid_client', `Client authentication failed (${method})`, 401);
    return row;
  }

  /** RFC 7591 dynamic registration (when `dcrEnabled`). */
  async register(body: DcrRequest, meta: { ip: string | null; userAgent: string | null }): Promise<Record<string, unknown>> {
    if (!(await this.settings.get('dcrEnabled'))) throw new OAuthError('access_denied', 'Dynamic client registration is disabled on this gateway', 403);
    const invalid = (d: string) => new OAuthError('invalid_client_metadata', d);
    const appType = body.application_type === undefined ? 'native' : body.application_type;
    if (appType !== 'native' && appType !== 'web') throw invalid('application_type must be native or web');
    if (!Array.isArray(body.redirect_uris) || !body.redirect_uris.length || body.redirect_uris.length > 20) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list 1–20 URIs');
    for (const r of body.redirect_uris) {
      if (typeof r !== 'string' || r.length > 2048) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be strings');
      const err = validRedirectUri(r, appType);
      if (err) throw new OAuthError('invalid_redirect_uri', `${r} ${err}`);
    }
    // MCP clients are overwhelmingly public native apps: default to `none` (RFC 7591's default is client_secret_basic)
    const method = body.token_endpoint_auth_method ?? 'none';
    if (method !== 'none' && method !== 'client_secret_basic' && method !== 'client_secret_post') throw invalid('token_endpoint_auth_method must be none, client_secret_basic or client_secret_post');
    const grants = body.grant_types === undefined ? ['authorization_code', 'refresh_token'] : body.grant_types;
    if (!Array.isArray(grants) || !grants.every((g) => g === 'authorization_code' || g === 'refresh_token') || !grants.includes('authorization_code')) throw invalid('grant_types must include authorization_code and may include refresh_token');
    const responses = body.response_types === undefined ? ['code'] : body.response_types;
    if (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code') throw invalid('response_types must be ["code"]');
    const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 200) : 'Unnamed client';
    const clientUri = typeof body.client_uri === 'string' && /^https?:\/\//i.test(body.client_uri) ? body.client_uri.slice(0, 2048) : null;
    const now = this.clock.now();
    const clientId = `${DCR_PREFIX}${randomToken(16)}`;
    const secret = method === 'none' ? null : `nr_cs_${randomToken(32)}`;
    const id = newId();
    await this.db
      .insertInto('oauth_clients')
      .values({
        id,
        client_id: clientId,
        registration_type: 'dcr',
        client_name: name,
        client_uri: clientUri,
        // DCR logos are unverified: never shown
        logo_uri: null,
        redirect_uris: toJsonColumn(body.redirect_uris),
        grant_types: toJsonColumn(grants),
        response_types: toJsonColumn(responses),
        token_endpoint_auth_method: method,
        client_secret_hash: secret ? hmacSha256(this.pepper, secret) : null,
        application_type: appType,
        metadata: toJsonColumn({ ...body, client_secret: undefined }),
        metadata_fetched_at: null,
        metadata_expires_at: null,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
    this.audit.auth({ userId: null, action: 'oauth.client.register', decision: 'allowed', reason: `${name} (${clientId}) → ${(body.redirect_uris as string[]).join(' ')}`.slice(0, 500), ip: meta.ip, userAgent: meta.userAgent });
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      ...(clientUri ? { client_uri: clientUri } : {}),
      redirect_uris: body.redirect_uris,
      grant_types: grants,
      response_types: responses,
      token_endpoint_auth_method: method,
      application_type: appType,
      scope: 'mcp:tools',
    };
  }

  /* ---------------------------------------------------------------- admin */

  async list(q: { q?: string | undefined; registration?: string | undefined; status?: string | undefined; cursor?: string | undefined; limit?: number | undefined }): Promise<{ items: OAuthClientRow[]; nextCursor: string | null }> {
    const limit = clampLimit(q.limit);
    let qb = this.db.selectFrom('oauth_clients').selectAll();
    if (q.q) {
      const like = `%${q.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      qb = qb.where((eb) => eb.or([eb(eb.fn('lower', ['client_name']), 'like', like), eb(eb.fn('lower', ['client_id']), 'like', like)]));
    }
    if (q.registration) qb = qb.where('registration_type', '=', q.registration as ClientRow['registration_type']);
    if (q.status) qb = qb.where('status', '=', q.status as ClientRow['status']);
    const key = decodeCursor(q.cursor);
    if (key) {
      const [ts, id] = key;
      if (typeof ts !== 'number' || typeof id !== 'string') throw AppError.validation('Invalid cursor', [{ path: ['cursor'], message: 'Invalid cursor', code: 'invalid_cursor' }]);
      qb = qb.where((eb) => eb.or([eb('created_at', '<', ts), eb.and([eb('created_at', '=', ts), eb('id', '<', id)])]));
    }
    const rows = await qb.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
    const slice = rows.slice(0, limit);
    const items = await this.toRows(slice);
    const last = slice.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor([Number(last.created_at), last.id]) : null };
  }

  private async toRows(rows: ClientRow[]): Promise<OAuthClientRow[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [users, used] = await Promise.all([
      this.db.selectFrom('oauth_consents').select(['client_id', sql<number>`count(distinct user_id)`.as('n')]).where('client_id', 'in', ids).where('revoked_at', 'is', null).groupBy('client_id').execute(),
      this.db.selectFrom('oauth_tokens').select(['client_id', sql<number>`max(last_used_at)`.as('last')]).where('client_id', 'in', ids).groupBy('client_id').execute(),
    ]);
    return rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      name: r.client_name,
      registration: r.registration_type,
      redirectUris: parseJsonColumn<string[]>(r.redirect_uris) ?? [],
      status: r.status,
      userCount: Number(users.find((u) => u.client_id === r.id)?.n ?? 0),
      lastUsedAt: toIsoOrNull(Number(used.find((u) => u.client_id === r.id)?.last ?? 0) || null),
      createdAt: toIso(Number(r.created_at)),
    }));
  }

  /** Block / unblock. Blocking revokes every live token of the client on all replicas. */
  async update(id: string, status: 'active' | 'blocked', admin: UserSubject): Promise<OAuthClientRow> {
    const row = await this.byRowId(id);
    if (!row) throw AppError.notFound('OAuth client');
    const now = this.clock.now();
    await this.db.updateTable('oauth_clients').set({ status, updated_at: now }).where('id', '=', id).execute();
    if (status === 'blocked') {
      await this.db.updateTable('oauth_tokens').set({ revoked_at: now }).where('client_id', '=', id).where('revoked_at', 'is', null).execute();
      await this.coord.publish(AUTH_REVOKED_CHANNEL, { oauthClientId: id });
    }
    this.audit.admin({ actorUserId: admin.id, action: status === 'blocked' ? 'oauth_client.block' : 'oauth_client.unblock', targetType: 'oauth_client', targetId: id, before: { status: row.status }, after: { status } });
    return (await this.toRows([(await this.byRowId(id))!]))[0]!;
  }
}
