import type { Kysely } from 'kysely';
import type { ConsentDecisionBody, ConsentRequest } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import { sameResource } from '../auth/mcp/authenticate.js';
import type { MainDB } from '../db/schema.js';
import type { UserSubject } from '../identity/principal.js';
import { toIso, type Clock } from '../lib/clock.js';
import { hmacSha256, hmacSha256Hex, randomToken, timingSafeEqualStr } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../lib/json.js';
import { OAuthError } from './cimd.js';
import { OAuthClientsService, type ResolvedClient } from './clients.service.js';
import { parseScope, SCOPE_DESCRIPTIONS } from './metadata.js';
import { PKCE_CHALLENGE_RE } from './pkce.js';
import { isLoopbackRedirect, redirectUriMatches, withParams } from './redirect-uri.js';
import type { OAuthTokensService } from './tokens.service.js';

export const AUTHZ_REQUEST_TTL_MS = 10 * 60_000;

/** Validated authorization request parameters stored with the pending consent. */
export interface AuthzParams {
  redirect_uri: string;
  scope: string[];
  state: string | null;
  code_challenge: string;
  resource: string;
}

export type AuthorizeOutcome =
  /** Shown to the user; never redirected to an unverified redirect_uri. */
  | { kind: 'error_page'; status: number; error: string; description: string }
  /** Error returned to the (verified) redirect_uri with state + iss. */
  | { kind: 'redirect'; location: string }
  /** No web session: sign in first, then resume this exact URL. */
  | { kind: 'login'; location: string }
  /** Consent page with the binding cookie. */
  | { kind: 'consent'; location: string; requestId: string; cookieValue: string };

/**
 * Authorization endpoint + consent API of the gateway AS (backend §7.4 steps 1–6). Confused-
 * deputy protections: per-request consent (always shown in P1), exact redirect URI matching,
 * errors before redirect_uri validation are shown (not redirected), the request id is single-use
 * and bound to the signed-in user, the consent POST must carry an HMAC cookie bound to
 * (request, user) plus the session CSRF token, `state` is round-tripped untouched and `iss` is
 * always sent (RFC 9207).
 */
export class AuthorizationService {
  private readonly cookieKey: Buffer;

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly clients: OAuthClientsService,
    private readonly tokens: OAuthTokensService,
    private readonly audit: AuditRecorder,
    private readonly o: { issuer: string; resourceUri: string; pepper: string },
  ) {
    this.cookieKey = hmacSha256(o.pepper, 'neurouter:oauth-consent-cookie');
  }

  consentCookieValue(requestId: string, userId: string): string {
    return `${requestId}.${hmacSha256Hex(this.cookieKey, `${requestId}:${userId}`)}`;
  }

  private cookieMatches(value: string | undefined, requestId: string, userId: string): boolean {
    return !!value && timingSafeEqualStr(value, this.consentCookieValue(requestId, userId));
  }

  async authorize(q: Record<string, string | undefined>, resumeUrl: string, user: UserSubject | null): Promise<AuthorizeOutcome> {
    const page = (error: string, description: string, status = 400): AuthorizeOutcome => ({ kind: 'error_page', status, error, description });
    // 1 client
    let client: ResolvedClient;
    try {
      client = await this.clients.resolve(q.client_id ?? '');
    } catch (err) {
      if (err instanceof OAuthError) return page(err.error, err.description);
      throw err;
    }
    // 2 redirect_uri (exact; loopback any-port). Until this passes, nothing is redirected.
    let redirectUri = q.redirect_uri;
    if (!redirectUri) {
      if (client.redirectUris.length !== 1) return page('invalid_request', 'redirect_uri is required');
      redirectUri = client.redirectUris[0]!;
    }
    if (!redirectUriMatches(client.redirectUris, redirectUri)) return page('invalid_request', `redirect_uri ${redirectUri} is not registered for ${client.row.client_name}`);

    const state = q.state ?? null;
    const back = (error: string, description: string): AuthorizeOutcome => ({ kind: 'redirect', location: withParams(redirectUri!, { error, error_description: description, state, iss: this.o.issuer }) });
    // 3 request checks
    if (q.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
    if (!client.grantTypes.includes('authorization_code')) return back('unauthorized_client', 'This client may not use the authorization code grant');
    if (!q.code_challenge || !PKCE_CHALLENGE_RE.test(q.code_challenge)) return back('invalid_request', 'code_challenge (PKCE S256) is required');
    if (q.code_challenge_method !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
    if (!q.resource) return back('invalid_target', `resource is required (RFC 8707); use ${this.o.resourceUri}`);
    if (!sameResource(q.resource, this.o.resourceUri)) return back('invalid_target', `Unknown resource; this server's resource is ${this.o.resourceUri}`);
    const scope = parseScope(q.scope);
    if (!scope) return back('invalid_scope', 'Unsupported scope; supported: mcp:tools');
    // 4 sign in first (OIDC / dev login), then resume this exact request
    if (!user) return { kind: 'login', location: `/auth/login?returnTo=${encodeURIComponent(resumeUrl)}` };
    // 5 single-use request bound to this user
    const id = newId();
    const params: AuthzParams = { redirect_uri: redirectUri, scope, state, code_challenge: q.code_challenge, resource: this.o.resourceUri };
    await this.db.insertInto('oauth_authz_requests').values({ id, client_id: client.row.id, params: toJsonColumn(params), user_id: user.id, csrf_token: randomToken(16), expires_at: this.clock.now() + AUTHZ_REQUEST_TTL_MS }).execute();
    return { kind: 'consent', location: `/auth/consent?request=${id}`, requestId: id, cookieValue: this.consentCookieValue(id, user.id) };
  }

  private async request(requestId: string, viewer: UserSubject) {
    const r = await this.db.selectFrom('oauth_authz_requests').selectAll().where('id', '=', requestId).executeTakeFirst();
    if (!r) throw AppError.notFound('Authorization request');
    if (r.user_id !== viewer.id) throw AppError.forbidden('This authorization request belongs to another user');
    if (Number(r.expires_at) <= this.clock.now()) throw AppError.gone('This authorization request has expired; start again from your MCP client');
    const client = await this.clients.byRowId(r.client_id);
    if (!client) throw AppError.notFound('Authorization request');
    return { r, client: OAuthClientsService.view(client), params: parseJsonColumn<AuthzParams>(r.params)! };
  }

  async get(requestId: string, viewer: UserSubject): Promise<ConsentRequest> {
    const { r, client, params } = await this.request(requestId, viewer);
    const row = client.row;
    const cimd = row.registration_type === 'cimd';
    const agents = await this.db.selectFrom('agents').select(['id', 'name']).where('owner_user_id', '=', viewer.id).where('kind', '=', 'oauth_client').where('oauth_client_id', '=', row.id).where('status', '=', 'active').orderBy('name').execute();
    return {
      client: {
        id: row.client_id,
        idHost: cimd ? new URL(row.client_id).host : null,
        name: row.client_name,
        logoUri: cimd ? row.logo_uri : null,
        clientUri: row.client_uri,
        registration: row.registration_type,
        verified: cimd,
      },
      redirectUri: params.redirect_uri,
      redirectHost: hostOf(params.redirect_uri),
      localhostOnly: client.redirectUris.length > 0 && client.redirectUris.every(isLoopbackRedirect),
      scopes: params.scope.map((name) => ({ name, description: SCOPE_DESCRIPTIONS[name] ?? name })),
      resource: params.resource,
      expiresAt: toIso(Number(r.expires_at)),
      user: { email: viewer.email },
      agents: agents.map((a) => ({ id: a.id, name: a.name })),
    };
  }

  async decide(requestId: string, body: ConsentDecisionBody, viewer: UserSubject, consentCookie: string | undefined, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<{ redirectTo: string }> {
    const { client, params } = await this.request(requestId, viewer);
    if (!this.cookieMatches(consentCookie, requestId, viewer.id)) throw AppError.forbidden('The consent cookie is missing or does not match this request; restart the authorization from your MCP client');
    // single use: whoever deletes the row decides
    const del = await this.db.deleteFrom('oauth_authz_requests').where('id', '=', requestId).executeTakeFirst();
    if (!Number(del.numDeletedRows)) throw AppError.conflict('This authorization request was already decided');
    const row = client.row;
    const base = { state: params.state, iss: this.o.issuer };
    if (body.decision === 'deny') {
      this.audit.auth({ userId: viewer.id, action: 'oauth.consent.deny', decision: 'denied_acl', status: 'blocked', reason: `client ${row.client_id}`, ...meta });
      return { redirectTo: withParams(params.redirect_uri, { error: 'access_denied', error_description: 'The user denied the request', ...base }) };
    }
    let scopes = params.scope;
    if (body.scopes) {
      if (!body.scopes.length || body.scopes.some((s) => !params.scope.includes(s))) throw AppError.validation('scopes must be a non-empty subset of the requested scopes', [{ path: ['scopes'], message: 'Must be a subset of the requested scopes', code: 'invalid_scope' }]);
      scopes = [...new Set(body.scopes)];
    }
    const agentId = await this.agentFor(body, viewer, row.id, row.client_name);
    const now = this.clock.now();
    await this.db
      .insertInto('oauth_consents')
      .values({ id: newId(), user_id: viewer.id, client_id: row.id, agent_id: agentId, scopes: scopes.join(' '), redirect_uri: params.redirect_uri, created_at: now, revoked_at: null })
      .onConflict((oc) => oc.columns(['user_id', 'client_id', 'redirect_uri']).doUpdateSet({ agent_id: agentId, scopes: scopes.join(' '), created_at: now, revoked_at: null }))
      .execute();
    const code = await this.tokens.issueCode({ clientRowId: row.id, userId: viewer.id, agentId, redirectUri: params.redirect_uri, codeChallenge: params.code_challenge, scopes, resource: params.resource });
    this.audit.auth({ userId: viewer.id, action: 'oauth.consent.approve', decision: 'allowed', reason: `client ${row.client_id} → agent ${agentId}`, ...meta });
    return { redirectTo: withParams(params.redirect_uri, { code, ...base }) };
  }

  /** Reuses one of the viewer's agents bound to this client, or creates one (kind `oauth_client`). */
  private async agentFor(body: ConsentDecisionBody, viewer: UserSubject, clientRowId: string, clientName: string): Promise<string> {
    if (body.agentId) {
      const a = await this.db.selectFrom('agents').select(['id', 'owner_user_id', 'kind', 'oauth_client_id', 'status']).where('id', '=', body.agentId).executeTakeFirst();
      if (!a || a.owner_user_id !== viewer.id || a.status !== 'active') throw AppError.validation('Unknown agent', [{ path: ['agentId'], message: 'Not one of your active agents', code: 'invalid_agent' }]);
      if (a.kind !== 'oauth_client' || a.oauth_client_id !== clientRowId) throw AppError.validation('This agent is not bound to this app', [{ path: ['agentId'], message: 'Pick an agent created for this app, or create a new one', code: 'invalid_agent' }]);
      return a.id;
    }
    const wanted = (body.agentName ?? clientName).trim().slice(0, 100) || 'MCP client';
    const taken = new Set((await this.db.selectFrom('agents').select('name').where('owner_user_id', '=', viewer.id).execute()).map((a) => a.name));
    let name = wanted;
    for (let i = 2; taken.has(name); i++) name = `${wanted.slice(0, 95)} (${i})`;
    const id = newId();
    const now = this.clock.now();
    await this.db.insertInto('agents').values({ id, owner_user_id: viewer.id, name, description: `Authorized via OAuth (${clientName})`.slice(0, 500), kind: 'oauth_client', oauth_client_id: clientRowId, exposure_mode: null, rate_limit: null, last_seen_at: null, created_at: now, updated_at: now }).execute();
    this.audit.admin({ actorUserId: viewer.id, action: 'agent.create', targetType: 'agent', targetId: id, after: { name, kind: 'oauth_client', oauthClientId: clientRowId } });
    return id;
  }
}

function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || u.protocol;
  } catch {
    return uri;
  }
}
