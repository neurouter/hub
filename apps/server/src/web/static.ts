import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isNonSpaPath } from '@neurouter/shared';

/** CSP for the SPA (backend §16.4, decision Q9: icons are proxied, so no remote img-src). */
export const WEB_CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  objectSrc: ["'none'"],
};

const NO_CACHE_FILES = new Set(['index.html', 'theme-init.js']);

export function cacheControlFor(relPath: string): string {
  const p = relPath.replace(/^\/+/, '');
  if (p.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  if (NO_CACHE_FILES.has(p)) return 'no-cache';
  return 'public, max-age=3600';
}

/** True when a not-found request should get the SPA's index.html. */
export function wantsSpa(req: Pick<FastifyRequest, 'method' | 'url' | 'headers'>): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = req.url.split('?')[0] ?? '/';
  if (isNonSpaPath(path)) return false;
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/html') || accept.includes('*/*') || accept === '';
}

export interface StaticOptions {
  distDir: string;
}

/**
 * Serves the built web app with immutable caching for hashed assets and an SPA fallback.
 * Returns false (and registers nothing) when the build output is missing.
 */
export async function registerWebStatic(app: FastifyInstance, opts: StaticOptions): Promise<boolean> {
  if (!existsSync(join(opts.distDir, 'index.html'))) return false;
  await app.register(fastifyStatic, {
    root: opts.distDir,
    prefix: '/',
    wildcard: false,
    index: false,
    setHeaders(res, filePath) {
      const rel = filePath.slice(opts.distDir.length).replaceAll('\\', '/');
      res.header('cache-control', cacheControlFor(rel));
    },
  });
  // `wildcard: false` registers routes for files present at boot; GET / is the SPA entry
  app.get('/', (_req, reply) => sendIndex(reply));
  return true;
}

export function sendIndex(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-cache').sendFile('index.html');
}
