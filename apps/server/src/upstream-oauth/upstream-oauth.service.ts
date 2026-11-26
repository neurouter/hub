import type { Kysely } from 'kysely';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  OAuthError as SdkOAuthError,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  validateAuthorizationResponseIssuer,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import { isAdmin, isSafeReturnTo } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB } from '../db/schema.js';
import type { UserSubject } from '../identity/principal.js';
import type { Clock } from '../lib/clock.js';
import { hmacSha256, randomToken } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../lib/json.js';
import type { FetchLike } from '../lib/net/safe-fetch.js';
import { loadAclPrincipal, type AclService } from '../policy/acl-cache.js';
import { pack, unpack } from '../secrets/envelope.js';
import type { EnvelopeService } from '../secrets/envelope.service.js';
import type { SecretProvider } from '../secrets/provider.js';
import { upstreamTokenAad, type CredentialResolver } from '../upstream/credentials.js';

export const UPSTREAM_STATE_TTL_MS = 10 * 60_000;
/** Refresh on use when the access token expires within this window (§6). */
export const REFRESH_SKEW_MS = 60_000;
const DISCOVERY_TTL_MS = 3_600_000;

export interface OauthConfig {
  discovery: 'auto' | 'manual';
  authorizationServerUrl: string | null;
  clientId: string | null;
  clientIdMode: 'cimd' | 'preregistered' | 'dcr';
  scopes: string[];
}

interface Discovered {
  asUrl: string;
  metadata: AuthorizationServerMetadata;
  resource: string;
  at: number;
}

const stateAad = (hashHex: string) => `neurouter:upstream-oauth-state:${hashHex}`;

/** The gateway's own Client ID Metadata Document, served at `/oauth/client-metadata.json` (§7.5). */
export function gatewayClientMetadata(publicUrl: string, orgName: string) {
  return {
    client_id: `${publicUrl}/oauth/client-metadata.json`,
    client_name: `Neurouter Hub (${orgName})`,
    client_uri: publicUrl,
    redirect_uris: [`${publicUrl}/oauth/upstream/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/**
 * Per-user upstream OAuth (backend §7.5): the gateway is an OAuth client of upstream MCP servers
 * with `auth_mode='user_oauth'`. Discovery (RFC 9728 PRM → RFC 8414 with issuer validation),
 * connect with PKCE + RFC 8707 resource + state bound to the web session user, callback with
 * RFC 9207 `iss` validation, encrypted token storage, refresh on use and by job (under a
 * cluster lock), and best-effort revocation on disconnect. Never a token passthrough: the MCP
 * client's gateway token never reaches the upstream, and upstream tokens never leave the gateway.
 */
export class UpstreamOAuthService {
  private readonly discovered = new Map<string, Discovered>();

  constructor(
    private readonly d: {
      db: Kysely<MainDB>;
      clock: Clock;
      envelope: EnvelopeService;
      secrets: SecretProvider;
      acl: AclService;
      coord: CoordinationStore;
      audit: AuditRecorder;
      credentials: CredentialResolver;
      /** Fetch used for discovery, token and revocation calls (the upstream's network policy). */
      fetchFor: (server: { id: string; url: string }) => FetchLike;
      publicUrl: string;
      orgName: string;
      pepper: string;
      log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };
      /** Called after the first connection to a server that has never synced (Q7 sync user). */
      onConnected?: (serverId: string, userId: string) => void;
      /** A user's tokens changed (connect/refresh/fail): drop their pooled upstream connection. */
      onTokensChanged?: (serverId: string, userId: string) => void;
    },
  ) {
    d.credentials.refresher = (userId, serverId) => this.refresh(userId, serverId);
  }

  get callbackUrl(): string {
    return `${this.d.publicUrl}/oauth/upstream/callback`;
  }

  private async server(serverId: string) {
    const s = await this.d.db.selectFrom('servers').select(['id', 'name', 'slug', 'url', 'auth_mode', 'oauth_config', 'enabled', 'status', 'owner_user_id', 'last_synced_at']).where('id', '=', serverId).executeTakeFirst();
    if (!s || s.auth_mode !== 'user_oauth') throw AppError.notFound('Server');
    return { ...s, config: parseJsonColumn<OauthConfig>(s.oauth_config) ?? { discovery: 'auto', authorizationServerUrl: null, clientId: null, clientIdMode: 'cimd', scopes: [] } };
  }

  /** RFC 9728 + RFC 8414 discovery (issuer validated by the SDK), cached for an hour. */
  async discover(server: { id: string; url: string; config: OauthConfig }, force = false): Promise<Discovered> {
    const hit = this.discovered.get(server.id);
    if (hit && !force && this.d.clock.now() - hit.at < DISCOVERY_TTL_MS) return hit;
    const fetchFn = this.d.fetchFor(server);
    let asUrl: string;
    let metadata: AuthorizationServerMetadata | undefined;
    let resource = server.url;
    if (server.config.discovery === 'manual' && server.config.authorizationServerUrl) {
      asUrl = server.config.authorizationServerUrl;
      metadata = await discoverAuthorizationServerMetadata(asUrl, { fetchFn });
    } else {
      const info = await discoverOAuthServerInfo(server.url, { fetchFn });
      asUrl = info.authorizationServerUrl;
      metadata = info.authorizationServerMetadata;
      if (info.resourceMetadata?.resource) resource = String(info.resourceMetadata.resource);
    }
    if (!metadata) throw new AppError('upstream_unavailable', `Could not discover the authorization server for ${server.url}`);
    const out = { asUrl, metadata, resource, at: this.d.clock.now() };
    this.discovered.set(server.id, out);
    return out;
  }

  /** Client identity at the upstream AS: pre-registered, our CIMD URL, or a one-time DCR registration. */
  private async clientInfo(server: Awaited<ReturnType<UpstreamOAuthService['server']>>, disc: Discovered): Promise<OAuthClientInformationMixed> {
    const cfg = server.config;
    const secretFor = async (): Promise<string | undefined> => {
      const cred = await this.d.db.selectFrom('server_credentials').select('secret_id').where('server_id', '=', server.id).where('kind', '=', 'oauth_client_secret').executeTakeFirst();
      return cred ? (await this.d.secrets.get({ id: cred.secret_id })).toString('utf8') : undefined;
    };
    if (cfg.clientId && (cfg.clientIdMode === 'preregistered' || cfg.clientIdMode === 'dcr')) {
      const secret = await secretFor();
      return { client_id: cfg.clientId, ...(secret ? { client_secret: secret } : {}) };
    }
    const cimd = gatewayClientMetadata(this.d.publicUrl, this.d.orgName);
    if ((disc.metadata as { client_id_metadata_document_supported?: boolean }).client_id_metadata_document_supported) return { client_id: cimd.client_id };
    if (!disc.metadata.registration_endpoint) throw AppError.conflict(`${server.name}'s authorization server supports neither client metadata documents nor dynamic registration; an admin must configure a pre-registered client id`);
    // register once and remember the result (clientIdMode → dcr)
    const { client_id: _drop, ...clientMetadata } = cimd;
    const reg = await registerClient(disc.asUrl, { metadata: disc.metadata, clientMetadata: { ...clientMetadata, token_endpoint_auth_method: 'none' } as never, fetchFn: this.d.fetchFor(server) });
    const next: OauthConfig = { ...cfg, clientId: reg.client_id, clientIdMode: 'dcr' };
    await this.d.db.updateTable('servers').set({ oauth_config: toJsonColumn(next), updated_at: this.d.clock.now() }).where('id', '=', server.id).execute();
    this.d.audit.system('upstream_oauth.dcr_registered', { targetType: 'server', targetId: server.id, changes: { clientId: reg.client_id } });
    return { client_id: reg.client_id };
  }

  private async mayConnect(serverId: string, ownerId: string, viewer: UserSubject): Promise<boolean> {
    if (isAdmin(viewer) || ownerId === viewer.id) return true;
    const principal = await loadAclPrincipal(this.d.db, viewer.id, null);
    const decisions = await this.d.acl.explain(principal);
    if (decisions.some((x) => x.tool.serverId === serverId && x.decision.decision === 'allow')) return true;
    // a server-level grant counts even before the first tool sync
    const subjects = [viewer.id, ...viewer.groups.map((g) => g.id)];
    const g = await this.d.db.selectFrom('grants').select('id').where('target_type', '=', 'server').where('target_id', '=', serverId).where('effect', '=', 'allow').where('subject_id', 'in', subjects).where('subject_type', 'in', ['user', 'group']).limit(1).executeTakeFirst();
    return !!g;
  }

  /**
   * Starts a connection: state (single-use, 10 min, bound to this user) + PKCE + resource.
   * Returns the upstream authorization URL to redirect the browser to.
   */
  async authorizeUrl(serverId: string, viewer: UserSubject, returnTo: string | undefined): Promise<string> {
    const server = await this.server(serverId);
    if (!server.enabled || server.status === 'disabled') throw AppError.conflict(`${server.name} is disabled`);
    if (!(await this.mayConnect(server.id, server.owner_user_id, viewer))) throw AppError.forbidden(`You don't have access to ${server.name}; request access first`);
    const disc = await this.discover(server);
    const clientInformation = await this.clientInfo(server, disc);
    const state = randomToken(32);
    const scope = server.config.scopes.length ? server.config.scopes.join(' ') : (disc.metadata.scopes_supported ?? []).join(' ') || undefined;
    const { authorizationUrl, codeVerifier } = await startAuthorization(disc.asUrl, { metadata: disc.metadata, clientInformation, redirectUrl: this.callbackUrl, state, resource: disc.resource, ...(scope ? { scope } : {}) });
    const hash = hmacSha256(this.d.pepper, state);
    const sealed = await this.d.envelope.seal(Buffer.from(codeVerifier), stateAad(hash.toString('hex')));
    await this.d.db
      .insertInto('upstream_oauth_states')
      .values({
        state_hash: hash,
        user_id: viewer.id,
        server_id: server.id,
        issuer: disc.metadata.issuer,
        code_verifier_enc: Buffer.concat([Buffer.from(sealed.dekId.padEnd(36).slice(0, 36)), pack(sealed)]),
        redirect_after: returnTo && isSafeReturnTo(returnTo) && !returnTo.startsWith('/api/') ? returnTo : '/connections',
        expires_at: this.d.clock.now() + UPSTREAM_STATE_TTL_MS,
      })
      .execute();
    return authorizationUrl.toString();
  }

  /**
   * `/oauth/upstream/callback`: validates state (single-use, bound to the session user) and `iss`
   * (RFC 9207), exchanges the code with PKCE + resource, stores encrypted tokens. Always returns
   * the SPA location to redirect to (`?connected=` or `?error=&server=`).
   */
  async callback(q: Record<string, string | undefined>, viewer: UserSubject | null): Promise<string> {
    const fail = (to: string, code: string, serverId?: string) => {
      const u = new URL(to, 'http://x');
      u.searchParams.set('error', code);
      if (serverId) u.searchParams.set('server', serverId);
      return `${u.pathname}${u.search}`;
    };
    if (!q.state) return fail('/connections', 'invalid_state');
    const hash = hmacSha256(this.d.pepper, q.state);
    const row = await this.d.db.selectFrom('upstream_oauth_states').selectAll().where('state_hash', '=', hash).executeTakeFirst();
    if (!row) return fail('/connections', 'invalid_state');
    await this.d.db.deleteFrom('upstream_oauth_states').where('state_hash', '=', hash).execute();
    const back = row.redirect_after;
    if (!viewer || viewer.id !== row.user_id) return fail(back, 'session_mismatch', row.server_id);
    if (Number(row.expires_at) <= this.d.clock.now()) return fail(back, 'expired', row.server_id);
    if (q.error) return fail(back, /^[a-z_]{1,64}$/.test(q.error) ? q.error : 'upstream_error', row.server_id);
    if (!q.code) return fail(back, 'invalid_request', row.server_id);
    try {
      const server = await this.server(row.server_id);
      const disc = await this.discover(server);
      if (disc.metadata.issuer !== row.issuer) return fail(back, 'issuer_mismatch', row.server_id);
      validateAuthorizationResponseIssuer({ iss: q.iss, expectedIssuer: row.issuer, issParameterSupported: !!(disc.metadata as { authorization_response_iss_parameter_supported?: boolean }).authorization_response_iss_parameter_supported });
      const dekId = row.code_verifier_enc.subarray(0, 36).toString().trim();
      const codeVerifier = (await this.d.envelope.open({ dekId, ...unpack(row.code_verifier_enc.subarray(36)) }, stateAad(hash.toString('hex')))).toString();
      const tokens = await exchangeAuthorization(disc.asUrl, { metadata: disc.metadata, clientInformation: await this.clientInfo(server, disc), authorizationCode: q.code, ...(q.iss ? { iss: q.iss } : {}), codeVerifier, redirectUri: this.callbackUrl, resource: disc.resource, fetchFn: this.d.fetchFor(server) });
      await this.save(row.user_id, server.id, row.issuer, tokens, null);
      this.d.audit.admin({ actorUserId: viewer.id, action: 'connection.connect', targetType: 'server', targetId: server.id });
      if (server.last_synced_at === null) this.d.onConnected?.(server.id, viewer.id);
      const u = new URL(back, 'http://x');
      u.searchParams.set('connected', server.id);
      return `${u.pathname}${u.search}`;
    } catch (err) {
      this.d.log.warn({ err, serverId: row.server_id }, 'upstream OAuth callback failed');
      const code = err instanceof SdkOAuthError ? (/^[a-z_]{1,64}$/.test(String(err.code)) ? String(err.code) : 'token_exchange_failed') : /iss/i.test((err as Error).message) ? 'issuer_mismatch' : 'token_exchange_failed';
      return fail(back, code, row.server_id);
    }
  }

  /** Encrypts and upserts the user's tokens (keeps the old refresh token when the AS doesn't rotate). */
  async save(userId: string, serverId: string, issuer: string, t: OAuthTokens, previousRefresh: string | null): Promise<void> {
    const now = this.d.clock.now();
    const access = await this.d.envelope.seal(Buffer.from(t.access_token), upstreamTokenAad(userId, serverId, 'access'));
    const refreshValue = t.refresh_token ?? previousRefresh;
    const refresh = refreshValue ? await this.d.envelope.seal(Buffer.from(refreshValue), upstreamTokenAad(userId, serverId, 'refresh')) : null;
    const values = {
      issuer,
      dek_id: access.dekId,
      access_nonce: access.nonce,
      access_ct: access.ciphertext,
      refresh_nonce: refresh?.nonce ?? null,
      refresh_ct: refresh?.ciphertext ?? null,
      token_type: t.token_type || 'Bearer',
      scopes: t.scope ?? '',
      expires_at: t.expires_in ? now + Number(t.expires_in) * 1000 : null,
      status: 'active' as const,
      refreshed_at: now,
      updated_at: now,
    };
    await this.d.db
      .insertInto('user_upstream_tokens')
      .values({ id: newId(), user_id: userId, server_id: serverId, created_at: now, ...values })
      .onConflict((oc) => oc.columns(['user_id', 'server_id']).doUpdateSet(values))
      .execute();
    this.d.credentials.invalidate(serverId);
    this.d.onTokensChanged?.(serverId, userId);
  }

  private async readRefresh(row: { dek_id: string; refresh_nonce: Buffer | null; refresh_ct: Buffer | null; user_id: string; server_id: string }): Promise<string | null> {
    if (!row.refresh_ct || !row.refresh_nonce) return null;
    return (await this.d.envelope.open({ dekId: row.dek_id, nonce: row.refresh_nonce, ciphertext: row.refresh_ct }, upstreamTokenAad(row.user_id, row.server_id, 'refresh'))).toString('utf8');
  }

  /**
   * Refreshes one user's token under a cluster-wide lock (only one replica talks to the AS).
   * `invalid_grant` → status `refresh_failed` (the portal shows "reconnect").
   */
  async refresh(userId: string, serverId: string, opts: { withinMs?: number } = {}): Promise<'refreshed' | 'fresh' | 'failed' | 'no_refresh_token'> {
    return this.d.coord.withLock(`upstream-refresh:${userId}:${serverId}`, 30_000, async () => {
      const row = await this.d.db.selectFrom('user_upstream_tokens').selectAll().where('user_id', '=', userId).where('server_id', '=', serverId).executeTakeFirst();
      if (!row || row.status !== 'active') return 'failed';
      const within = opts.withinMs ?? REFRESH_SKEW_MS;
      if (row.expires_at === null || Number(row.expires_at) - this.d.clock.now() > within) return 'fresh';
      const refreshToken = await this.readRefresh(row);
      if (!refreshToken) return 'no_refresh_token';
      const server = await this.server(serverId);
      try {
        const disc = await this.discover(server);
        const tokens = await refreshAuthorization(disc.asUrl, { metadata: disc.metadata, clientInformation: await this.clientInfo(server, disc), refreshToken, resource: disc.resource, fetchFn: this.d.fetchFor(server) });
        await this.save(userId, serverId, row.issuer, tokens, refreshToken);
        return 'refreshed';
      } catch (err) {
        if (err instanceof SdkOAuthError && (err.code === 'invalid_grant' || err.code === 'invalid_client' || err.code === 'unauthorized_client')) {
          await this.d.db.updateTable('user_upstream_tokens').set({ status: 'refresh_failed', updated_at: this.d.clock.now() }).where('id', '=', row.id).execute();
          this.d.credentials.invalidate(serverId);
          this.d.onTokensChanged?.(serverId, userId);
          this.d.log.info({ userId, serverId, code: err.code }, 'upstream token refresh rejected; user must reconnect');
          return 'failed';
        }
        throw err;
      }
    });
  }

  /** Job `upstream-token-refresh`: tokens expiring within 10 min, for users active in the last 7 days. */
  async refreshDue(now = this.d.clock.now()): Promise<{ refreshed: number; failed: number; errors: number }> {
    const rows = await this.d.db
      .selectFrom('user_upstream_tokens as t')
      .innerJoin('users as u', 'u.id', 't.user_id')
      .select(['t.user_id', 't.server_id'])
      .where('t.status', '=', 'active')
      .where('t.refresh_ct', 'is not', null)
      .where('t.expires_at', 'is not', null)
      .where('t.expires_at', '<', now + 10 * 60_000)
      .where('u.status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('u.last_login_at', '>', now - 7 * 86_400_000),
          eb.exists(eb.selectFrom('agents as a').select('a.id').whereRef('a.owner_user_id', '=', 'u.id').where('a.last_seen_at', '>', now - 7 * 86_400_000)),
        ]),
      )
      .limit(500)
      .execute();
    const out = { refreshed: 0, failed: 0, errors: 0 };
    for (const r of rows) {
      try {
        const res = await this.refresh(r.user_id, r.server_id, { withinMs: 10 * 60_000 });
        if (res === 'refreshed') out.refreshed++;
        if (res === 'failed') out.failed++;
      } catch (err) {
        out.errors++;
        this.d.log.warn({ err, serverId: r.server_id }, 'upstream token refresh failed (will retry)');
      }
    }
    return out;
  }

  /** Best-effort RFC 7009 revocation at the upstream AS before a disconnect deletes the row. */
  async revokeAtUpstream(userId: string, serverId: string): Promise<boolean> {
    try {
      const row = await this.d.db.selectFrom('user_upstream_tokens').selectAll().where('user_id', '=', userId).where('server_id', '=', serverId).executeTakeFirst();
      if (!row) return false;
      const server = await this.server(serverId);
      const disc = await this.discover(server);
      const endpoint = (disc.metadata as { revocation_endpoint?: string }).revocation_endpoint;
      if (!endpoint) return false;
      const token = (await this.readRefresh(row)) ?? (await this.d.envelope.open({ dekId: row.dek_id, nonce: row.access_nonce, ciphertext: row.access_ct }, upstreamTokenAad(userId, serverId, 'access'))).toString('utf8');
      const client = await this.clientInfo(server, disc);
      const body = new URLSearchParams({ token, token_type_hint: row.refresh_ct ? 'refresh_token' : 'access_token', client_id: client.client_id });
      if ('client_secret' in client && client.client_secret) body.set('client_secret', client.client_secret);
      const res = await this.d.fetchFor(server)(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      return res.ok;
    } catch (err) {
      this.d.log.warn({ err, serverId }, 'upstream token revocation failed (continuing with local disconnect)');
      return false;
    }
  }

  /** Re-encrypts tokens under the active DEK (DEK rotation job). */
  async reencryptAll(activeDekId: string): Promise<number> {
    let n = 0;
    for (;;) {
      const rows = await this.d.db.selectFrom('user_upstream_tokens').selectAll().where('dek_id', '!=', activeDekId).limit(200).execute();
      if (!rows.length) return n;
      for (const r of rows) {
        const access = await this.d.envelope.open({ dekId: r.dek_id, nonce: r.access_nonce, ciphertext: r.access_ct }, upstreamTokenAad(r.user_id, r.server_id, 'access'));
        const refresh = await this.readRefresh(r);
        const a = await this.d.envelope.seal(access, upstreamTokenAad(r.user_id, r.server_id, 'access'));
        const f = refresh ? await this.d.envelope.seal(Buffer.from(refresh), upstreamTokenAad(r.user_id, r.server_id, 'refresh')) : null;
        await this.d.db.updateTable('user_upstream_tokens').set({ dek_id: a.dekId, access_nonce: a.nonce, access_ct: a.ciphertext, refresh_nonce: f?.nonce ?? null, refresh_ct: f?.ciphertext ?? null }).where('id', '=', r.id).execute();
        access.fill(0);
        n++;
      }
    }
  }

  async cleanupStates(now = this.d.clock.now()): Promise<number> {
    const res = await this.d.db.deleteFrom('upstream_oauth_states').where('expires_at', '<', now).executeTakeFirst();
    return Number(res.numDeletedRows);
  }
}
