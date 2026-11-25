import type { FastifyInstance } from 'fastify';
import { api, can } from '@neurouter/shared';
import type { Services } from '../../deps.js';
import { requireAdmin, requireCap, requireUser } from '../../auth/web/guards.js';
import { fromIso } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { registerEndpoint } from '../routes.js';

/** Step 3 REST: servers, tools, jobs, icon proxy, OIDC discovery test. */
export async function catalogRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const ownerOf = (req: Parameters<typeof requireUser>[0], serverId: string, cap: 'servers:write' | 'tools:write' = 'servers:write') => {
    const user = requireUser(req);
    if (!can(user, cap, { serverId })) throw AppError.forbidden();
    return user;
  };

  /* ---------------------------------------------------------------- servers */
  registerEndpoint(app, api.servers.list, async (req) => s.servers.list(req.query, requireUser(req)));
  registerEndpoint(app, api.servers.testConnection, async (req) => s.servers.testConnection(req.body, requireUser(req)));
  registerEndpoint(app, api.servers.create, async (req) => {
    const user = requireCap(req, 'servers:create');
    const id = await s.servers.create(req.body, user);
    if (req.body.libraryEntryId) await s.library.linkImported(req.body.libraryEntryId, id);
    const jobId = await s.catalog.startSync(id, 'manual', user.id, { initial: true });
    return { ...(await s.servers.get(id, { ...user, ownedServerIds: [...user.ownedServerIds, id] })), initialSync: { jobId } };
  });
  registerEndpoint(app, api.servers.get, async (req) => s.servers.get(req.params.id, requireUser(req)));
  registerEndpoint(app, api.servers.update, async (req) => {
    const user = requireUser(req);
    await s.servers.update(req.params.id, req.body, user);
    // a new (or removed) icon override is fetched now, so the response already carries it
    if (req.body.iconUrl !== undefined) await s.icons.refresh(req.params.id).catch(() => null);
    return s.servers.get(req.params.id, user);
  });
  registerEndpoint(app, api.servers.quality, async (req) => {
    await s.servers.loadForViewer(req.params.id, requireUser(req));
    return s.library.serverQuality(req.params.id);
  });
  registerEndpoint(app, api.servers.delete, async (req) => s.servers.delete(req.params.id, requireAdmin(req)));
  registerEndpoint(app, api.servers.putCredentials, async (req) => s.servers.putCredentials(req.params.id, req.body, requireAdmin(req)));

  registerEndpoint(app, api.servers.icon, async (req, reply) => {
    requireUser(req);
    const server = await s.dbs.main.db.selectFrom('servers').select(['id', 'status']).where('id', '=', req.params.id).executeTakeFirst();
    const icon = server && server.status !== 'disabled' ? await s.icons.get(server.id) : null;
    if (!icon) throw AppError.notFound('Icon');
    const etag = `"${icon.etag}"`;
    reply
      .header('etag', etag)
      .header('cache-control', 'private, max-age=86400')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('x-content-type-options', 'nosniff');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.type(icon.contentType).status(200).send(icon.bytes);
  });
  registerEndpoint(app, api.servers.refreshIcon, async (req) => {
    const user = ownerOf(req, req.params.id);
    await s.servers.loadForViewer(req.params.id, user);
    return s.icons.refresh(req.params.id);
  });
  registerEndpoint(app, api.servers.sync, async (req) => {
    const user = ownerOf(req, req.params.id);
    await s.servers.loadForViewer(req.params.id, user);
    s.audit.admin({ actorUserId: user.id, action: 'server.sync', targetType: 'server', targetId: req.params.id });
    return { jobId: await s.catalog.startSync(req.params.id, 'manual', user.id) };
  });
  registerEndpoint(app, api.servers.syncRuns, async (req) => {
    const user = requireCap(req, 'servers:read', { serverId: req.params.id });
    await s.servers.loadForViewer(req.params.id, user);
    return s.catalogQueries.syncRuns(req.params.id, req.query);
  });
  registerEndpoint(app, api.servers.healthCheck, async (req) => {
    const user = ownerOf(req, req.params.id);
    await s.servers.loadForViewer(req.params.id, user);
    return s.health.check(req.params.id);
  });
  registerEndpoint(app, api.servers.health, async (req) => {
    const user = requireCap(req, 'servers:read', { serverId: req.params.id });
    await s.servers.loadForViewer(req.params.id, user);
    const to = req.query.to ? fromIso(req.query.to) : s.clock.now();
    const from = req.query.from ? fromIso(req.query.from) : to - 86_400_000;
    if (to <= from) throw AppError.validation('`to` must be after `from`', [{ path: ['to'], message: 'Must be after from', code: 'invalid_range' }]);
    return s.health.history(req.params.id, from, to);
  });

  /* ---------------------------------------------------------------- tools */
  registerEndpoint(app, api.tools.list, async (req) => s.tools.list(req.query, requireUser(req)));
  registerEndpoint(app, api.tools.get, async (req) => s.tools.get(req.params.id, requireUser(req)));
  registerEndpoint(app, api.tools.update, async (req) => s.tools.update(req.params.id, req.body, requireUser(req)));
  registerEndpoint(app, api.tools.bulk, async (req) => s.tools.bulk(req.body, requireUser(req)));
  registerEndpoint(app, api.tools.definitionDiff, async (req) => s.tools.diff(req.params.id, requireUser(req)));
  registerEndpoint(app, api.tools.approveDefinition, async (req) => s.tools.approve(req.params.id, req.body.hash, requireUser(req)));
  registerEndpoint(app, api.tools.approveDefinitions, async (req) => s.tools.approveMany(req.body.items, requireUser(req)));
  registerEndpoint(app, api.tools.rejectDefinition, async (req) => s.tools.reject(req.params.id, req.body.note, requireUser(req)));
  registerEndpoint(app, api.tools.versions, async (req) => s.tools.versions(req.params.id, req.query, requireUser(req)));

  /* ---------------------------------------------------------------- jobs */
  registerEndpoint(app, api.jobs.get, async (req) => s.jobs.get(req.params.id, requireUser(req)));

  /* ---------------------------------------------------------------- OIDC discovery test (SSRF-guarded) */
  registerEndpoint(app, api.settings.testOidc, async (req) => {
    requireAdmin(req);
    const issuer = req.body.issuer.replace(/\/$/, '');
    try {
      const res = await s.outboundFetch(`${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
      if (res.status !== 200) return { ok: false, issuer, authorizationEndpoint: null, error: `Discovery returned HTTP ${res.status}` };
      const doc = (await res.json()) as { issuer?: unknown; authorization_endpoint?: unknown };
      if (doc.issuer !== issuer && doc.issuer !== req.body.issuer) return { ok: false, issuer, authorizationEndpoint: null, error: `Issuer mismatch: discovery says ${String(doc.issuer)}` };
      return { ok: true, issuer, authorizationEndpoint: typeof doc.authorization_endpoint === 'string' ? doc.authorization_endpoint : null, error: null };
    } catch (err) {
      return { ok: false, issuer, authorizationEndpoint: null, error: (err as Error).message.slice(0, 300) };
    }
  });

  /* ---------------------------------------------------------------- MCP server library */
  registerEndpoint(app, api.library.status, async (req) => {
    requireAdmin(req);
    return s.library.status();
  });
  registerEndpoint(app, api.library.updateSettings, async (req) => s.library.updateSettings(req.body, requireAdmin(req).id));
  registerEndpoint(app, api.library.sync, async (req) => ({ started: await s.library.startSync(requireAdmin(req).id) }));
  registerEndpoint(app, api.library.list, async (req) => {
    requireAdmin(req);
    return s.library.list(req.query);
  });
  registerEndpoint(app, api.library.get, async (req) => {
    requireAdmin(req);
    return s.library.get(req.params.id);
  });
  registerEndpoint(app, api.library.icon, async (req, reply) => {
    requireAdmin(req);
    const icon = await s.library.icons.get(req.params.id);
    if (!icon) {
      reply.header('cache-control', 'private, max-age=3600');
      throw AppError.notFound('Icon');
    }
    const etag = `"${icon.etag}"`;
    reply
      .header('etag', etag)
      .header('cache-control', 'private, max-age=86400')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('x-content-type-options', 'nosniff');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.type(icon.contentType).status(200).send(icon.bytes);
  });
  registerEndpoint(app, api.library.check, async (req) => s.library.check(req.params.id, requireAdmin(req).id));
  registerEndpoint(app, api.library.update, async (req) => s.library.update(req.params.id, req.body, requireAdmin(req).id));
}
