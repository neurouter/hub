import type { FastifyInstance } from 'fastify';
import { api } from '@neurouter/shared';
import type { Services } from '../../deps.js';
import { clientMeta, requireAdmin, requireUser } from '../../auth/web/guards.js';
import { registerEndpoint } from '../routes.js';

/** Step 10 REST: MCP OAuth consent, authorized apps (per user) and the admin OAuth client list. */
export async function oauthApiRoutes(app: FastifyInstance, s: Services): Promise<void> {
  registerEndpoint(app, api.oauth.getConsent, async (req) => s.authorization.get(req.params.requestId, requireUser(req)));
  registerEndpoint(app, api.oauth.decideConsent, async (req) =>
    s.authorization.decide(req.params.requestId, req.body, requireUser(req), req.cookies?.[s.config.cookieNames.consent], clientMeta(req)),
  );
  registerEndpoint(app, api.oauth.myGrants, async (req) => s.oauthTokens.myGrants(requireUser(req), req.query.agentId));
  registerEndpoint(app, api.oauth.revokeMyGrant, async (req) => s.oauthTokens.revokeGrant(req.params.id, requireUser(req)));
  registerEndpoint(app, api.oauth.clients, async (req) => {
    requireUser(req); // admin/auditor enforced by the contract access gate
    return s.oauthClients.list(req.query);
  });
  registerEndpoint(app, api.oauth.updateClient, async (req) => s.oauthClients.update(req.params.id, req.body.status, requireAdmin(req)));
}
