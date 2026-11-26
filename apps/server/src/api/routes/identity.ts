import type { FastifyInstance } from 'fastify';
import { api, capabilitiesFor, isAdmin, SPA_PATHS, SUPPORTED_PROTOCOL_VERSIONS, type Badges } from '@neurouter/shared';
import { sql, type SqlBool } from 'kysely';
import type { Services } from '../../deps.js';
import { clientMeta, requireAdmin, requireCap, requireUser } from '../../auth/web/guards.js';
import { AppError } from '../../lib/errors.js';
import { registerEndpoint } from '../routes.js';

function themePrefs(p: Record<string, unknown>): { theme?: 'light' | 'dark' | 'system' } {
  const t = p.theme;
  return t === 'light' || t === 'dark' || t === 'system' ? { theme: t } : {};
}

/** Step 2 REST: auth, me, users, groups, agents + keys + scope, OIDC role mappings, portal/system info. */
export async function identityRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const { config } = s;
  const devLoginEnabled = config.env.AUTH_DEV_LOGIN && config.env.NODE_ENV === 'development';
  const loginError = (code: string) => `${SPA_PATHS.login}?error=${encodeURIComponent(code)}`;

  /* ---------------------------------------------------------------- auth */
  registerEndpoint(app, api.auth.providers, async () => ({
    productName: config.env.ORG_NAME === 'Neurouter' ? 'Neurouter Hub' : `Neurouter Hub · ${config.env.ORG_NAME}`,
    providers: [
      ...(s.login.oidcEnabled ? [{ id: 'oidc' as const, displayName: config.env.OIDC_DISPLAY_NAME }] : []),
      ...(devLoginEnabled ? [{ id: 'dev' as const, displayName: 'Developer login' }] : []),
    ],
  }));

  registerEndpoint(app, api.auth.login, async (req, reply) => {
    if (!s.login.oidcEnabled) return reply.redirect(loginError('idp_error'), 302);
    try {
      return reply.redirect(await s.login.start(req.query.returnTo), 302);
    } catch (err) {
      req.log.warn({ err }, 'OIDC login start failed');
      return reply.redirect(loginError('idp_error'), 302);
    }
  });

  registerEndpoint(app, api.auth.callback, async (req, reply) => {
    const currentUrl = new URL(req.url, config.publicUrl);
    const out = await s.login.finish(currentUrl, clientMeta(req));
    if (!out.ok) {
      req.log.info({ reason: out.reason }, 'login failed');
      return reply.redirect(loginError(out.error), 302);
    }
    const sess = await s.sessions.create(out.userId, { ...clientMeta(req), idTokenHint: out.idToken });
    s.sessions.setCookie(reply, sess.token, sess.expiresAt);
    return reply.redirect(out.returnTo, 302);
  });

  registerEndpoint(app, api.auth.devLogin, async (req, reply) => {
    if (!devLoginEnabled) throw AppError.notFound();
    const out = await s.login.devLogin(req.body.email, req.body.name, clientMeta(req));
    if (!out.ok) throw new AppError('forbidden', out.error === 'disabled' ? 'This account is disabled' : 'Login refused', { extensions: { reason: out.error } });
    const sess = await s.sessions.create(out.userId, clientMeta(req));
    s.sessions.setCookie(reply, sess.token, sess.expiresAt);
  });

  registerEndpoint(app, api.auth.logout, async (req, reply) => {
    const user = requireUser(req);
    const session = req.webAuth!.session;
    await s.sessions.destroy(session.idHash);
    s.sessions.clearCookie(reply);
    s.audit.auth({ userId: user.id, action: 'auth.logout', ...clientMeta(req) });
    const idp = s.oidcProvider ? await s.oidcProvider.endSessionUrl({ idTokenHint: session.idTokenHint, postLogoutRedirectUri: `${config.publicUrl}${SPA_PATHS.loggedOut}` }) : null;
    return { redirectTo: idp ?? SPA_PATHS.loggedOut };
  });

  /* ---------------------------------------------------------------- me */
  registerEndpoint(app, api.me.me, async (req) => {
    const user = requireUser(req);
    return {
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
      roles: user.roles,
      groups: user.groups,
      capabilities: capabilitiesFor(user),
      ownedServerIds: user.ownedServerIds,
      csrfToken: req.webAuth!.session.csrfToken,
      serverTime: new Date(s.clock.now()).toISOString(),
      features: { skills: false, favorites: false, toolSearch: true, oauthClients: true },
      org: { name: config.env.ORG_NAME },
      version: s.version,
      preferences: themePrefs(user.preferences),
    };
  });

  registerEndpoint(app, api.me.updatePreferences, async (req) => {
    const user = requireUser(req);
    const prefs = { ...user.preferences, ...req.body };
    await s.dbs.main.db.updateTable('users').set({ preferences: JSON.stringify(prefs), updated_at: s.clock.now() }).where('id', '=', user.id).execute();
    return { preferences: themePrefs(prefs) };
  });

  registerEndpoint(app, api.me.badges, async (req): Promise<Badges> => {
    const user = requireUser(req);
    const db = s.dbs.main.db;
    const admin = isAdmin(user);
    const owned = user.ownedServerIds;
    const reviewer = admin || owned.length > 0;
    const count = async (q: { executeTakeFirst(): Promise<{ n: number | string | bigint } | undefined> }) => Number((await q.executeTakeFirst())?.n ?? 0);
    const scope = admin ? sql<SqlBool>`1 = 1` : owned.length ? sql<SqlBool>`server_id in (${sql.join(owned)})` : sql<SqlBool>`1 = 0`;
    const n = sql<number>`count(*)`.as('n');
    const [pendingApprovals, pendingAccessRequests, toolsPendingReview, myPendingRequests, brokenConnections] = await Promise.all([
      reviewer ? count(db.selectFrom('approvals').select(n).where('status', '=', 'pending').where(scope)) : 0,
      reviewer ? count(db.selectFrom('access_requests').select(n).where('status', '=', 'pending').where(scope)) : 0,
      reviewer ? count(db.selectFrom('tools').select(n).where('status', 'in', ['pending_review', 'changed']).where(scope)) : 0,
      count(db.selectFrom('access_requests').select(n).where('requester_user_id', '=', user.id).where('status', '=', 'pending')),
      count(db.selectFrom('user_upstream_tokens').select(n).where('user_id', '=', user.id).where('status', '!=', 'active')),
    ]);
    return { pendingApprovals, pendingAccessRequests, toolsPendingReview, myPendingRequests, brokenConnections };
  });

  registerEndpoint(app, api.portal.clientConfig, async (req) => {
    requireUser(req);
    return { mcpUrl: config.resourceUri, oauthSupported: true, protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], serverName: 'neurouter', apiKeyHeader: 'Authorization: Bearer' };
  });

  registerEndpoint(app, api.system.info, async (req) => {
    const user = requireUser(req);
    const base = { version: s.version, searchMode: s.search.mode(), mcpUrl: config.resourceUri, protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] };
    if (!isAdmin(user)) return base;
    const st = s.embedder.status();
    const searchIndex = await s.indexer.coverage();
    return { ...base, dbDialect: s.dbs.main.dialect, embeddingModel: st === 'disabled' ? null : s.embedder.modelId, embeddingReady: st === 'ready', instanceId: config.instanceId, searchIndex };
  });

  /* ---------------------------------------------------------------- users */
  registerEndpoint(app, api.users.list, async (req) => {
    requireCap(req, 'users:read');
    return s.users.list(req.query);
  });
  registerEndpoint(app, api.users.create, async (req) => s.users.create(req.body, requireAdmin(req)));
  registerEndpoint(app, api.users.get, async (req) => s.users.detail(req.params.id, requireCap(req, 'users:read')));
  registerEndpoint(app, api.users.update, async (req) => s.users.update(req.params.id, req.body, requireAdmin(req)));

  /* ---------------------------------------------------------------- groups */
  registerEndpoint(app, api.groups.list, async (req) => s.groups.list(req.query, requireUser(req)));
  registerEndpoint(app, api.groups.create, async (req) => s.groups.create(req.body, requireAdmin(req)));
  registerEndpoint(app, api.groups.get, async (req) => s.groups.detail(req.params.id, requireCap(req, 'groups:read')));
  registerEndpoint(app, api.groups.update, async (req) => s.groups.update(req.params.id, req.body, requireAdmin(req)));
  registerEndpoint(app, api.groups.delete, async (req) => s.groups.delete(req.params.id, requireAdmin(req)));
  registerEndpoint(app, api.groups.members, async (req) => {
    requireCap(req, 'groups:read');
    return s.groups.members(req.params.id, req.query);
  });
  registerEndpoint(app, api.groups.addMembers, async (req) => s.groups.addMembers(req.params.id, req.body, requireAdmin(req)));
  registerEndpoint(app, api.groups.removeMember, async (req) => s.groups.removeMember(req.params.id, req.params.userId, requireAdmin(req)));
  registerEndpoint(app, api.groups.claimMappings, async (req) => {
    requireCap(req, 'groups:read');
    return s.groups.mappings(req.params.id);
  });
  registerEndpoint(app, api.groups.createClaimMapping, async (req) => s.groups.createMapping(req.params.id, req.body, requireAdmin(req)));
  registerEndpoint(app, api.groups.deleteClaimMapping, async (req) => s.groups.deleteMapping(req.params.id, req.params.mappingId, requireAdmin(req)));

  /* ---------------------------------------------------------------- agents */
  registerEndpoint(app, api.agents.list, async (req) => s.agents.list(req.query, requireUser(req)));
  registerEndpoint(app, api.agents.create, async (req) => s.agents.create(req.body, requireUser(req)));
  registerEndpoint(app, api.agents.get, async (req) => s.agents.get(req.params.id, requireUser(req)));
  registerEndpoint(app, api.agents.update, async (req) => s.agents.update(req.params.id, req.body, requireUser(req)));
  registerEndpoint(app, api.agents.delete, async (req) => s.agents.delete(req.params.id, requireUser(req)));
  registerEndpoint(app, api.agents.keys, async (req) => s.agents.keys(req.params.id, requireUser(req)));
  registerEndpoint(app, api.agents.createKey, async (req) => s.agents.createKey(req.params.id, req.body, requireUser(req)));
  registerEndpoint(app, api.agents.revokeKey, async (req) => s.agents.revokeKey(req.params.id, req.params.keyId, requireUser(req)));
  registerEndpoint(app, api.agents.revokeAllKeys, async (req) => s.agents.revokeAll(req.params.id, requireAdmin(req)));
  registerEndpoint(app, api.agents.getScope, async (req) => s.agents.getScope(req.params.id, requireUser(req)));
  registerEndpoint(app, api.agents.setScope, async (req) => s.agents.setScope(req.params.id, req.body, requireUser(req)));
  registerEndpoint(app, api.agents.access, async (req) => s.agents.access(req.params.id, requireUser(req)));

  /* ---------------------------------------------------------------- gateway settings */
  registerEndpoint(app, api.settings.get, async (req) => {
    requireCap(req, 'settings:read');
    return s.settingsApi.get();
  });
  registerEndpoint(app, api.settings.update, async (req) => s.settingsApi.update(req.body, requireAdmin(req).id));

  /* ---------------------------------------------------------------- OIDC settings (role mappings) */
  const oidcSettings = async () => ({
    issuer: config.env.OIDC_ISSUER ?? null,
    clientId: config.env.OIDC_CLIENT_ID ?? null,
    hasClientSecret: Boolean(config.env.OIDC_CLIENT_SECRET),
    scopes: config.env.OIDC_SCOPES.split(/\s+/).filter(Boolean),
    groupsClaim: config.env.OIDC_GROUPS_CLAIM,
    redirectUri: `${config.publicUrl}/api/auth/callback`,
    roleMappings: await s.settings.get('oidcRoleMappings'),
    source: 'env' as const,
  });
  registerEndpoint(app, api.settings.oidc, async (req) => {
    requireCap(req, 'settings:read');
    return oidcSettings();
  });
  registerEndpoint(
    app,
    api.settings.updateOidc,
    async (req) => {
    const user = requireAdmin(req);
    const before = await s.settings.get('oidcRoleMappings');
    const seen = new Set<string>();
    const mappings = req.body.roleMappings.filter((m) => {
      const k = `${m.claim}\u0000${m.value}\u0000${m.role}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    await s.settings.set('oidcRoleMappings', mappings, user.id);
    s.audit.admin({ actorUserId: user.id, action: 'settings.oidc.update', targetType: 'settings', targetId: 'oidc', before: { roleMappings: before }, after: { roleMappings: mappings } });
    return oidcSettings();
    },
    {
      // connection fields are env-only in P1 (Q16 / D2): reject them before zod strips unknown keys
      preValidation: async (req) => {
        requireAdmin(req);
        const raw = (req.body ?? {}) as Record<string, unknown>;
        const envOnly = Object.keys(raw).filter((k) => k !== 'roleMappings');
        if (envOnly.length) throw AppError.conflict(`OIDC connection settings come from the environment in this version (${envOnly.join(', ')})`);
      },
    },
  );
}
