import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from '../deps.js';
import { loadUserSubject, type UserSubject } from '../identity/principal.js';
import { OAuthError } from './cimd.js';
import { authorizationServerMetadata } from './metadata.js';
import { gatewayClientMetadata } from '../upstream-oauth/upstream-oauth.service.js';

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' } as const;

/** The web session user for non-`/api` routes (authorize, upstream callback). */
export async function sessionUser(req: FastifyRequest, s: Services): Promise<UserSubject | null> {
  const token = s.sessions.readCookie(req);
  if (!token) return null;
  const session = await s.sessions.validate(token);
  if (!session) return null;
  const user = await loadUserSubject(s.dbs.main.db, session.userId);
  return user && user.status === 'active' ? user : null;
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Minimal, script-free error page: authorization errors before redirect_uri validation are never redirected. */
export function errorPage(reply: FastifyReply, status: number, error: string, description: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization error</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#18181b}main{max-width:32rem;margin:1rem;padding:1.5rem;border:1px solid #e4e4e7;border-radius:.75rem;background:#fff}code{background:#f4f4f5;padding:.1rem .3rem;border-radius:.25rem}@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}main{background:#18181b;border-color:#27272a}code{background:#27272a}}</style></head>
<body><main><h1 style="font-size:1.125rem;margin:0 0 .5rem">This app can't be authorized</h1><p>${esc(description)}</p><p style="color:#71717a">Error: <code>${esc(error)}</code>. Close this window and check your MCP client's configuration, or contact your gateway administrator.</p></main></body></html>`;
  return reply.status(status).header('content-type', 'text/html; charset=utf-8').headers(NO_STORE).send(html);
}

function oauthError(reply: FastifyReply, err: OAuthError, basic = false) {
  if (err.status === 401 && basic) reply.header('www-authenticate', 'Basic realm="neurouter"');
  return reply.status(err.status).headers(NO_STORE).header('access-control-allow-origin', '*').send({ error: err.error, error_description: err.description });
}

function parseBasic(header: string | undefined): { id: string; secret: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (!m) return null;
  const raw = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = raw.indexOf(':');
  if (i < 0) return null;
  try {
    return { id: decodeURIComponent(raw.slice(0, i).replace(/\+/g, ' ')), secret: decodeURIComponent(raw.slice(i + 1).replace(/\+/g, ' ')) };
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Gateway-as-OAuth-AS endpoints outside `/api` (backend §7.4) plus the upstream OAuth client
 * endpoints (§7.5). `/oauth/*` keeps the RFC 6749 error format; the browser-facing authorize
 * endpoint renders an error page for problems that must not be redirected.
 */
export async function oauthRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const { config } = s;
  const issuer = config.publicUrl;

  const asMetadata = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.header('cache-control', 'public, max-age=3600').header('access-control-allow-origin', '*').send(authorizationServerMetadata(issuer, { dcrEnabled: await s.settings.get('dcrEnabled') }));
  app.get('/.well-known/oauth-authorization-server', asMetadata);
  // RFC 8414 path-inserted form for an issuer with a path is not needed (issuer has no path); OIDC alias for clients that try it first
  app.get('/.well-known/openid-configuration', asMetadata);

  app.get('/oauth/client-metadata.json', async (_req, reply) => reply.header('cache-control', 'public, max-age=3600').header('access-control-allow-origin', '*').send(gatewayClientMetadata(issuer, config.env.ORG_NAME)));

  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const user = await sessionUser(req, s);
    const out = await s.authorization.authorize(q, req.url, user);
    switch (out.kind) {
      case 'error_page':
        return errorPage(reply, out.status, out.error, out.description);
      case 'redirect':
      case 'login':
        return reply.headers(NO_STORE).redirect(out.location, 302);
      case 'consent':
        reply.setCookie(config.cookieNames.consent, out.cookieValue, { path: '/', httpOnly: true, secure: config.publicUrl.startsWith('https://'), sameSite: 'strict', maxAge: 600 });
        return reply.headers(NO_STORE).redirect(out.location, 302);
    }
  });

  const limit = async (req: FastifyRequest, route: string, perMinute: number): Promise<boolean> => {
    const r = await s.rateLimitStore.take(`ip:${req.ip}:${route}`, { capacity: perMinute, refillPerMs: perMinute / 60_000 });
    return r.allowed;
  };

  await app.register(async (scope) => {
    await scope.register(formbody, { bodyLimit: 64 * 1024 });
    for (const path of ['/oauth/token', '/oauth/register', '/oauth/revoke']) {
      scope.options(path, async (_req, reply) =>
        reply.status(204).header('access-control-allow-origin', '*').header('access-control-allow-methods', 'POST, OPTIONS').header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version').header('access-control-max-age', '600').send(),
      );
    }

    scope.post('/oauth/token', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const basic = parseBasic(req.headers.authorization);
      try {
        if (!(await limit(req, 'oauth_token', 120))) throw new OAuthError('slow_down', 'Too many token requests; retry shortly', 429);
        const client = await s.oauthClients.authenticate({ clientId: str(b.client_id), basic, postSecret: str(b.client_secret) });
        const grant = str(b.grant_type);
        let out;
        if (grant === 'authorization_code') out = await s.oauthTokens.redeemCode(client, { code: str(b.code), redirectUri: str(b.redirect_uri), codeVerifier: str(b.code_verifier), resource: str(b.resource) });
        else if (grant === 'refresh_token') out = await s.oauthTokens.refresh(client, { refreshToken: str(b.refresh_token), resource: str(b.resource), scope: str(b.scope) });
        else throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
        return reply.headers(NO_STORE).header('access-control-allow-origin', '*').send(out);
      } catch (err) {
        if (err instanceof OAuthError) return oauthError(reply, err, !!basic);
        throw err;
      }
    });

    scope.post('/oauth/register', async (req, reply) => {
      try {
        if (!(await limit(req, 'oauth_register', 10))) throw new OAuthError('slow_down', 'Too many registrations from this address; retry in a minute', 429);
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_client_metadata', 'Expected a JSON object');
        const out = await s.oauthClients.register(body as Record<string, unknown>, { ip: req.ip, userAgent: str(req.headers['user-agent']) ?? null });
        return reply.status(201).headers(NO_STORE).header('access-control-allow-origin', '*').send(out);
      } catch (err) {
        if (err instanceof OAuthError) return oauthError(reply, err);
        throw err;
      }
    });

    scope.post('/oauth/revoke', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const basic = parseBasic(req.headers.authorization);
      try {
        const client = await s.oauthClients.authenticate({ clientId: str(b.client_id), basic, postSecret: str(b.client_secret) });
        await s.oauthTokens.revoke(client, str(b.token));
        return reply.status(200).headers(NO_STORE).header('access-control-allow-origin', '*').send({});
      } catch (err) {
        if (err instanceof OAuthError) return oauthError(reply, err, !!basic);
        throw err;
      }
    });
  });

  app.get('/oauth/upstream/callback', async (req, reply) => {
    const location = await s.upstreamOAuth.callback(req.query as Record<string, string | undefined>, await sessionUser(req, s));
    return reply.headers(NO_STORE).redirect(location, 302);
  });
}
