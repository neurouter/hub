import type { FastifyInstance, FastifyRequest } from 'fastify';
import { can, isAdmin, type Capability, type CapabilityResource } from '@neurouter/shared';
import type { Kysely } from 'kysely';
import type { MainDB } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { timingSafeEqualStr } from '../../lib/crypto.js';
import { loadUserSubject, type UserSubject } from '../../identity/principal.js';
import type { SessionService, WebSession } from './sessions.js';

export interface WebAuth {
  user: UserSubject;
  session: WebSession;
}

declare module 'fastify' {
  interface FastifyRequest {
    webAuth: WebAuth | null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * `/api/*` session + CSRF hooks (backend §7.1, §14.1): loads the session user (active only),
 * requires `X-CSRF-Token` on every non-GET request that carries a session, and turns
 * malformed id path params into 404 (Postgres ids are uuid).
 */
export function installWebAuth(app: FastifyInstance, deps: { db: Kysely<MainDB>; sessions: SessionService }): void {
  app.decorateRequest('webAuth', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const token = deps.sessions.readCookie(req);
    if (!token) return;
    const session = await deps.sessions.validate(token);
    if (!session) return;
    const user = await loadUserSubject(deps.db, session.userId);
    if (!user || user.status !== 'active') return;
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !timingSafeEqualStr(header, session.csrfToken)) throw new AppError('forbidden', 'Missing or invalid CSRF token', { extensions: { reason: 'csrf' } });
    }
    req.webAuth = { user, session };
  });
  // Coarse gate from the contract's access levels, so a 401/403 wins over a 422 on bad input.
  app.addHook('preValidation', async (req) => {
    const access = (req.routeOptions.config as { access?: readonly string[] } | undefined)?.access;
    if (!access || access.includes('public')) return;
    const user = requireUser(req);
    if (access.every((a) => a === 'admin') && !isAdmin(user)) throw AppError.forbidden();
    if (access.every((a) => a === 'admin' || a === 'auditor') && !isAdmin(user) && !user.roles.includes('auditor')) throw AppError.forbidden();
  });
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || !req.webAuth) return;
    const params = req.params as Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(params ?? {})) {
      if ((k === 'id' || k.endsWith('Id')) && typeof v === 'string' && !isUuid(v)) throw AppError.notFound();
    }
  });
}

export function requireUser(req: FastifyRequest): UserSubject {
  if (!req.webAuth) throw AppError.unauthenticated();
  return req.webAuth.user;
}

export function requireCap(req: FastifyRequest, cap: Capability, resource?: CapabilityResource): UserSubject {
  const user = requireUser(req);
  if (!can(user, cap, resource)) throw AppError.forbidden();
  return user;
}

export function requireAnyCap(req: FastifyRequest, caps: readonly Capability[]): UserSubject {
  const user = requireUser(req);
  if (!caps.some((c) => can(user, c))) throw AppError.forbidden();
  return user;
}

export function requireAdmin(req: FastifyRequest): UserSubject {
  const user = requireUser(req);
  if (!isAdmin(user)) throw AppError.forbidden();
  return user;
}

export function clientMeta(req: FastifyRequest): { ip: string; userAgent: string | null } {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null };
}
