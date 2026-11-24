import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { api, Problem, type GroupRow } from '@neurouter/shared';
import { parseTrustProxy } from './app.js';
import { registerEndpoint } from './api/routes.js';
import { AppError } from './lib/errors.js';
import { createTestApp, type TestApp } from './test/fakes/app.js';

let t: TestApp | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const group: GroupRow = { id: 'g1', name: 'Engineering', description: '', source: 'local', memberCount: 0, mappingCount: 0, grantCount: 0 };

async function appWithContractRoutes() {
  return createTestApp({
    apiPlugins: [
      (a) => {
        registerEndpoint(a, api.groups.create, async (req) => ({ ...group, name: req.body.name }));
        registerEndpoint(a, api.users.list, async (req) => ({ items: [], nextCursor: null, totalEstimate: req.query.limit ?? 0 }));
        registerEndpoint(a, api.groups.delete, async () => {});
        registerEndpoint(a, api.groups.get, async (req) => {
          if (req.params.id === 'boom') throw new Error('secret internal detail');
          if (req.params.id === 'limited') throw AppError.rateLimited(9);
          if (req.params.id === 'bad-response') return { nope: true } as never;
          throw AppError.notFound('Group');
        });
      },
    ],
  });
}

function expectProblem(body: string, status: number, code: string) {
  const p = Problem.parse(JSON.parse(body));
  expect(p.status).toBe(status);
  expect(p.code).toBe(code);
  expect(p.requestId).toBeTruthy();
  return p;
}

describe('health endpoints', () => {
  it('serves liveness on /healthz and /health', async () => {
    t = await createTestApp();
    for (const url of ['/healthz', '/health']) {
      const res = await t.app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', version: '0.0.0-test' });
    }
  });

  it('reports readiness with DB and audit store checks', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.database.detail).toMatch(/sqlite-vec/);
    expect(body.checks.auditStore).toEqual({ ok: true });
  });

  it('is not ready before migrations', async () => {
    t = await createTestApp({ migrate: false });
    const res = await t.app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.auditStore.ok).toBe(false);
  });
});

describe('RFC 9457 error model', () => {
  it('returns problem+json for unknown API routes and echoes request ids', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ url: '/api/nope?x=1', headers: { 'x-request-id': 'req-12345678' } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.headers['x-request-id']).toBe('req-12345678');
    const p = expectProblem(res.body, 404, 'not_found');
    expect(p.type).toBe('https://neurouter.dev/problems/not-found');
    expect(p.instance).toBe('/api/nope');
    expect(p.requestId).toBe('req-12345678');
  });

  it('generates a UUIDv7 request id when the incoming one is unusable', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ url: '/api/nope', headers: { 'x-request-id': 'bad id!' } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps zod body validation to 422 with field paths', async () => {
    t = await appWithContractRoutes();
    const res = await t.app.inject({ method: 'POST', url: '/api/groups', payload: { name: '', description: 5 } });
    const p = expectProblem(res.body, 422, 'validation_failed');
    expect(p.detail).toBe('2 fields are invalid');
    expect(p.errors?.map((e) => e.path)).toEqual(expect.arrayContaining([['name'], ['description']]));
  });

  it('validates query strings from the contract', async () => {
    t = await appWithContractRoutes();
    const bad = await t.app.inject({ url: '/api/users?limit=999' });
    expect(expectProblem(bad.body, 422, 'validation_failed').errors?.[0]?.path).toEqual(['limit']);
    const ok = await t.app.inject({ url: '/api/users?limit=20&role=admin' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ items: [], nextCursor: null, totalEstimate: 20 });
  });

  it('serves valid contract responses and 204 for empty endpoints', async () => {
    t = await appWithContractRoutes();
    const res = await t.app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'Ops' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...group, name: 'Ops' });
    const del = await t.app.inject({ method: 'DELETE', url: '/api/groups/g1' });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
  });

  it('maps AppError codes and headers', async () => {
    t = await appWithContractRoutes();
    const nf = await t.app.inject({ url: '/api/groups/x' });
    expect(expectProblem(nf.body, 404, 'not_found').detail).toBe('Group not found');
    const rl = await t.app.inject({ url: '/api/groups/limited' });
    expectProblem(rl.body, 429, 'rate_limited');
    expect(rl.headers['retry-after']).toBe('9');
  });

  it('never leaks internal errors and rejects invalid responses', async () => {
    t = await appWithContractRoutes();
    const boom = await t.app.inject({ url: '/api/groups/boom' });
    const p = expectProblem(boom.body, 500, 'internal');
    expect(boom.body).not.toContain('secret internal detail');
    expect(p.detail).toBe('Something went wrong');
    const bad = await t.app.inject({ url: '/api/groups/bad-response' });
    expectProblem(bad.body, 500, 'internal');
  });

  it('maps malformed JSON to 400 and wrong content type to 415', async () => {
    t = await appWithContractRoutes();
    const res = await t.app.inject({ method: 'POST', url: '/api/groups', payload: '{"name":', headers: { 'content-type': 'application/json' } });
    expectProblem(res.body, 400, 'bad_request');
    const media = await t.app.inject({ method: 'POST', url: '/api/groups', payload: 'name=x', headers: { 'content-type': 'text/csv' } });
    expectProblem(media.body, 415, 'unsupported_media_type');
  });
});

describe('web app serving', () => {
  function makeDist() {
    const dir = mkdtempSync(join(tmpdir(), 'nr-web-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Neurouter</title>');
    writeFileSync(join(dir, 'theme-init.js'), '/* theme */');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    return dir;
  }

  it('serves the SPA with cache rules, fallback and CSP', async () => {
    const dist = makeDist();
    t = await createTestApp({ env: { SERVE_WEB: 'true', WEB_DIST_DIR: dist } });
    const index = await t.app.inject({ url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<title>Neurouter</title>');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(String(index.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(index.headers['x-frame-options']).toBe('DENY');

    const asset = await t.app.inject({ url: '/assets/index-abc123.js' });
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await t.app.inject({ url: '/theme-init.js' })).headers['cache-control']).toBe('no-cache');

    const deep = await t.app.inject({ url: '/admin/servers/123?tab=tools', headers: { accept: 'text/html' } });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<title>Neurouter</title>');

    const apiMiss = await t.app.inject({ url: '/api/missing', headers: { accept: 'text/html' } });
    expectProblem(apiMiss.body, 404, 'not_found');
    const wk = await t.app.inject({ url: '/.well-known/unknown', headers: { accept: 'text/html' } });
    expect(wk.statusCode).toBe(404);
    const jsonMiss = await t.app.inject({ url: '/catalog', headers: { accept: 'application/json' } });
    expect(jsonMiss.statusCode).toBe(404);
    const post = await t.app.inject({ method: 'POST', url: '/catalog', headers: { accept: 'text/html' } });
    expect(post.statusCode).toBe(404);
  });

  it('does not serve the SPA in dev and warns when the build is missing', async () => {
    t = await createTestApp();
    expect((await t.app.inject({ url: '/', headers: { accept: 'text/html' } })).statusCode).toBe(404);
    await t.close();
    t = await createTestApp({ env: { SERVE_WEB: 'true', WEB_DIST_DIR: '/nonexistent/dist', LOG_LEVEL: 'warn' } });
    expect(t.logs.join('')).toContain('web build not found');
  });
});

describe('parseTrustProxy', () => {
  it('handles booleans, hop counts and address lists', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('loopback,10.0.0.0/8')).toBe('loopback,10.0.0.0/8');
    const fn = parseTrustProxy('2') as (a: string, h: number) => boolean;
    expect(fn('x', 1)).toBe(true);
    expect(fn('x', 2)).toBe(false);
  });
});
