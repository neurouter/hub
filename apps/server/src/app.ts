import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import { errorHandler, notFoundProblem } from './api/problem.js';
import type { AuditStore } from './audit/store.js';
import type { Config } from './config/load.js';
import type { Databases } from './db/index.js';
import { healthRoutes } from './health/routes.js';
import type { Clock } from './lib/clock.js';
import { newId } from './lib/ids.js';
import { WEB_CSP_DIRECTIVES, registerWebStatic, sendIndex, wantsSpa } from './web/static.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  dbs: Databases;
  auditStore: AuditStore;
  clock: Clock;
  version: string;
  /** Route plugins for `/api/*` (identity, catalog, … in later steps); use `registerEndpoint`. */
  apiPlugins?: Array<(api: FastifyInstance) => Promise<void> | void>;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** `TRUST_PROXY`: 'true' / 'false' / hop count / comma list of IPs, CIDRs or 'loopback'. */
export function parseTrustProxy(value: string): boolean | string | ((addr: string, hop: number) => boolean) {
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return (_addr: string, hop: number) => hop < hops;
  }
  return value;
}

/** Pure wiring: plugins, error model, health, `/api` scope and (in production) the web app. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    trustProxy: parseTrustProxy(config.env.TRUST_PROXY),
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : newId();
    },
    routerOptions: { ignoreTrailingSlash: true },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', String(req.id));
  });

  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: WEB_CSP_DIRECTIVES },
    hsts: config.publicUrl.startsWith('https://') ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
  });
  await app.register(cookie);

  await app.register(healthRoutes, { dbs: deps.dbs, auditStore: deps.auditStore, version: deps.version });

  // Contract paths already include `/api`, so API plugins register in an unprefixed scope.
  await app.register(async (api) => {
    for (const plugin of deps.apiPlugins ?? []) await plugin(api);
  });

  let spa = false;
  if (config.serveWeb) {
    spa = await registerWebStatic(app, { distDir: config.webDistDir });
    if (!spa) app.log.warn({ dir: config.webDistDir }, 'web build not found; run `npm run build -w @neurouter/web` to serve the UI');
  }

  app.setNotFoundHandler((req, reply) => {
    if (spa && wantsSpa(req)) return sendIndex(reply);
    return notFoundProblem(req, reply);
  });

  return app;
}
