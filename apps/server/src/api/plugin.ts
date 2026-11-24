import type { FastifyInstance } from 'fastify';
import { installWebAuth } from '../auth/web/guards.js';
import type { Services } from '../deps.js';
import { catalogRoutes } from './routes/catalog.js';
import { identityRoutes } from './routes/identity.js';
import { gatewayRoutes } from './routes/gateway.js';
import { observabilityRoutes } from './routes/observability.js';
import { portalRoutes } from './routes/portal.js';
import { systemRoutes } from './routes/system.js';
import { approvalRoutes } from './routes/approvals.js';
import { oauthApiRoutes } from './routes/oauth.js';
import { oauthRoutes } from '../oauth/routes.js';

/** Every route plugin, wired from the composition root (passed to `buildApp({ apiPlugins })`). */
export function apiPlugins(s: Services): Array<(app: FastifyInstance) => Promise<void>> {
  return [
    async (app) => {
      installWebAuth(app, { db: s.dbs.main.db, sessions: s.sessions });
      await identityRoutes(app, s);
      await catalogRoutes(app, s);
      await gatewayRoutes(app, s);
      await observabilityRoutes(app, s);
      await portalRoutes(app, s);
      await systemRoutes(app, s);
      await approvalRoutes(app, s);
      await oauthApiRoutes(app, s);
      await oauthRoutes(app, s);
    },
  ];
}
