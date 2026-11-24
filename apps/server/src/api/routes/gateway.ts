import type { FastifyInstance } from 'fastify';
import { api } from '@neurouter/shared';
import type { Services } from '../../deps.js';
import { requireUser } from '../../auth/web/guards.js';
import { InflightCalls } from '../../gateway/inflight.js';
import { mcpRoutes } from '../../gateway/mcp-route.js';
import { registerEndpoint } from '../routes.js';

/** Step 4: `/mcp`, protected-resource metadata and the grants REST used by the ACL. */
export async function gatewayRoutes(app: FastifyInstance, s: Services): Promise<void> {
  registerEndpoint(app, api.grants.list, async (req) => s.grants.list(req.query, requireUser(req)));
  registerEndpoint(app, api.grants.create, async (req) => s.grants.create(req.body, requireUser(req)));
  registerEndpoint(app, api.grants.delete, async (req) => s.grants.delete(req.params.id, requireUser(req)));
  registerEndpoint(app, api.grants.batch, async (req) => s.grants.batch(req.body, requireUser(req)));
  registerEndpoint(app, api.grants.effective, async (req) => s.grants.effective(req.query, requireUser(req)));

  const { handlers } = await mcpRoutes(app, {
    publicUrl: s.config.publicUrl,
    resourceUri: s.config.resourceUri,
    allowedOrigins: s.config.env.MCP_ALLOWED_ORIGINS,
    version: s.version,
    authenticator: s.authenticator,
    pipeline: s.pipeline,
    bus: s.bus,
    inflight: new InflightCalls(s.coord),
    onAuthFailure: (reason, method) => {
      s.metrics.authFailure(method, reason);
      s.logger.debug({ reason }, 'mcp authentication failed');
    },
  });
  app.addHook('onClose', async () => {
    for (const h of handlers) await h.close();
  });
}
