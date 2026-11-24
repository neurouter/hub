import type { FastifyInstance } from 'fastify';
import { api, isSafeReturnTo } from '@neurouter/shared';
import { isAppError } from '../../lib/errors.js';
import type { Services } from '../../deps.js';
import { requireUser } from '../../auth/web/guards.js';
import { registerEndpoint } from '../routes.js';

/**
 * Step 7 REST: catalog (visibility setting, per-user access), access requests (request → owner
 * decides → grant), and per-user upstream connections. `/api/portal/client-config` and badges
 * live with the identity routes (step 2). Connect/authorize/disconnect use upstream OAuth (step 10).
 */
export async function portalRoutes(app: FastifyInstance, s: Services): Promise<void> {
  registerEndpoint(app, api.catalog.servers, async (req) => s.portalCatalog.servers(req.query, requireUser(req)));
  registerEndpoint(app, api.catalog.server, async (req) => s.portalCatalog.server(req.params.id, requireUser(req)));
  registerEndpoint(app, api.catalog.tools, async (req) => s.portalCatalog.tools(req.query, requireUser(req)));
  registerEndpoint(app, api.catalog.tags, async (req) => s.portalCatalog.tags(requireUser(req)));

  registerEndpoint(app, api.accessRequests.create, async (req) => s.accessRequests.create(req.body, requireUser(req)));
  registerEndpoint(app, api.accessRequests.listMine, async (req) => s.accessRequests.listMine(req.query, requireUser(req)));
  registerEndpoint(app, api.accessRequests.cancelMine, async (req) => s.accessRequests.cancelMine(req.params.id, requireUser(req)));
  registerEndpoint(app, api.accessRequests.list, async (req) => s.accessRequests.list(req.query, requireUser(req)));
  registerEndpoint(app, api.accessRequests.approve, async (req) => s.accessRequests.approve(req.params.id, req.body, requireUser(req)));
  registerEndpoint(app, api.accessRequests.deny, async (req) => s.accessRequests.deny(req.params.id, req.body.note, requireUser(req)));

  registerEndpoint(app, api.connections.list, async (req) => s.connections.list(requireUser(req)));
  registerEndpoint(app, api.connections.disconnect, async (req) => {
    const user = requireUser(req);
    // best-effort revocation at the upstream AS, then the local delete (§7.5)
    await s.upstreamOAuth.revokeAtUpstream(user.id, req.params.serverId);
    await s.connections.disconnect(req.params.serverId, user);
    s.pool.dropIdentity(req.params.serverId, user.id);
  });
  // browser navigation: errors come back as `?error=` on the Connections page, never as JSON
  registerEndpoint(app, api.connections.authorize, async (req, reply) => {
    const user = requireUser(req);
    const back = req.query.returnTo && isSafeReturnTo(req.query.returnTo) && !req.query.returnTo.startsWith('/api/') ? req.query.returnTo : '/connections';
    try {
      const url = await s.upstreamOAuth.authorizeUrl(req.params.serverId, user, back);
      return reply.header('cache-control', 'no-store').redirect(url, 302);
    } catch (err) {
      const code = isAppError(err) ? err.code : 'upstream_discovery_failed';
      if (!isAppError(err)) s.logger.warn({ err, serverId: req.params.serverId }, 'upstream OAuth start failed');
      const u = new URL(back, 'http://x');
      u.searchParams.set('error', code);
      u.searchParams.set('server', req.params.serverId);
      return reply.header('cache-control', 'no-store').redirect(`${u.pathname}${u.search}`, 302);
    }
  });
}
