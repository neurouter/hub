import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeUpstream } from '../../test-utils/fake-upstream.js';
import { createTestContext, FakeClock, type TestContext, type TestUser } from '../test/fakes/context.js';

const REG = 'https://registry.test';
const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);

interface Rec {
  server: Record<string, unknown>;
  _meta: Record<string, unknown>;
}

function rec(name: string, over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): Rec {
  return {
    server: { name, version: '1.0.0', description: `The ${name.split('/')[1]} server for testing search`, ...over },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true, publishedAt: '2026-01-10T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...meta } },
  };
}

const weather = rec('com.example/weather', {
  title: 'Weather',
  description: 'Hourly weather forecasts and severe weather alerts',
  websiteUrl: 'https://example.com',
  repository: { url: 'https://github.com/example/weather-mcp', source: 'github' },
  remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
});
const lookalike = rec('com.example/billing', {
  description: 'Billing and invoices for example customers',
  remotes: [{ type: 'streamable-http', url: 'https://billing.workers.dev/mcp', headers: [{ name: 'X-API-Key', isRequired: true, isSecret: true, description: 'API key from the dashboard settings page' }] }],
});
const sseOnly = rec('io.github.alice/notes', {
  description: 'Personal notes with full text search',
  repository: { url: 'https://github.com/alice/notes-mcp' },
  remotes: [{ type: 'sse', url: 'https://notes.alice.dev/sse' }, { type: 'streamable-http', url: 'https://notes.alice.dev/mcp' }],
});
const pkgOnly = rec('io.github.bob/files', { packages: [{ registryType: 'npm', identifier: '@bob/files-mcp', transport: { type: 'stdio' } }] });
const spam = ['io.github.s1', 'io.github.s2', 'io.github.s3', 'io.github.s4', 'io.github.s5'].map((ns, i) =>
  rec(`${ns}/tool${i}`, { description: 'Small public utility for autonomous clients.', remotes: [{ type: 'streamable-http', url: `https://s${i}.workers.dev/mcp` }] }),
);
const oldVersion = rec('com.example/weather', { version: '0.9.0', remotes: [{ type: 'streamable-http', url: 'https://old.example.com/mcp' }] }, { isLatest: false });
const gone = rec('io.github.mallory/evil', { remotes: [{ type: 'streamable-http', url: 'https://evil.test/mcp' }] }, { status: 'deleted' });

describe('MCP server library', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let alice: TestUser;
  let clock: FakeClock;
  let pages: Rec[][];
  let incremental: Rec[];
  let failSecondPage = false;
  const requests: string[] = [];
  let upstream: FakeUpstream;
  let locked: FakeUpstream;

  beforeEach(async () => {
    clock = new FakeClock(T0);
    requests.length = 0;
    pages = [[weather, lookalike, oldVersion, gone, sseOnly], [pkgOnly, ...spam]];
    incremental = [];
    failSecondPage = false;
    upstream = new FakeUpstream({
      tools: [
        { name: 'get_forecast', description: 'Returns the hourly forecast for a city for the next 48 hours.', inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] } },
        { name: 'x', description: '', inputSchema: { type: 'object', properties: { a: {} } } },
      ],
    });
    locked = new FakeUpstream({ requireAuth: { header: 'authorization', value: 'Bearer t' } });
    ctx = await createTestContext({
      clock,
      libraryFetch: async (input) => {
        const u = new URL(String(input));
        requests.push(u.pathname + u.search);
        if (u.host === 'api.github.com') {
          if (u.pathname === '/repos/example/weather-mcp') return Response.json({ archived: false, stargazers_count: 820, pushed_at: '2026-11-20T00:00:00Z', license: { spdx_id: 'Apache-2.0' }, owner: { type: 'Organization', login: 'example' } });
          return new Response('{}', { status: 404 });
        }
        if (u.origin !== REG || u.pathname !== '/v0.1/servers') return new Response('nope', { status: 404 });
        if (u.searchParams.get('updated_since')) return Response.json({ servers: incremental, metadata: { count: incremental.length } });
        const i = Number(u.searchParams.get('cursor') ?? 0);
        if (failSecondPage && i === 1) return new Response('boom', { status: 503 });
        return Response.json({ servers: pages[i] ?? [], metadata: i + 1 < pages.length ? { nextCursor: String(i + 1) } : {} });
      },
      libraryProbeFetch: async (input, init) => {
        const u = new URL(input instanceof Request ? input.url : String(input));
        if (u.host === 'mcp.example.com') return upstream.fetch(input, init);
        if (u.host === 'billing.workers.dev') {
          if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: 'https://billing.workers.dev/mcp', authorization_servers: ['https://auth.workers.dev'] });
          return locked.fetch(input, init);
        }
        throw new Error(`connect ECONNREFUSED ${u.host}`);
      },
    });
    admin = await ctx.user('admin@x.test', ['admin']);
    alice = await ctx.user('alice@x.test');
  });
  afterEach(async () => {
    await ctx.close();
    await upstream.close();
    await locked.close();
  });

  const enable = () => ctx.as(admin, { method: 'PATCH', url: '/api/library/settings', payload: { enabled: true, registryUrl: REG } });
  const list = async (qs = '') => {
    const r = await ctx.as(admin, { method: 'GET', url: `/api/library${qs}` });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };

  it('is off by default, admin-only, and makes no requests until enabled', async () => {
    const st = (await ctx.as(admin, { method: 'GET', url: '/api/library/status' })).json();
    expect(st).toMatchObject({ enabled: false, registryUrl: 'https://registry.modelcontextprotocol.io', hasGithubToken: false, counts: { total: 0 } });
    expect(st.attribution).toContain('Official MCP Registry');
    expect(await ctx.s.library.sync()).toBe('disabled');
    expect(requests).toEqual([]);
    expect((await ctx.as(admin, { method: 'POST', url: '/api/library/sync' })).statusCode).toBe(409);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/library' })).statusCode).toBe(403);
    expect((await ctx.as(alice, { method: 'PATCH', url: '/api/library/settings', payload: { enabled: true } })).statusCode).toBe(403);
    // the registry URL goes through the strict outbound policy
    const bad = await ctx.as(admin, { method: 'PATCH', url: '/api/library/settings', payload: { registryUrl: 'http://10.0.0.5/' } });
    expect(bad.statusCode).toBe(422);
  });

  it('full sync: latest active versions with an endpoint or package; deleted and old versions skipped; grades computed', async () => {
    expect((await enable()).statusCode).toBe(200);
    expect(await ctx.s.library.sync()).toBe('ok');
    expect(requests).toEqual(['/v0.1/servers?limit=100&version=latest', '/v0.1/servers?limit=100&version=latest&cursor=1']);

    const st = (await ctx.as(admin, { method: 'GET', url: '/api/library/status' })).json();
    expect(st).toMatchObject({ enabled: true, sync: { running: false, mode: 'full', pages: 2, lastError: null }, counts: { total: 9, remote: 8, checked: 0 } });

    const all = await list();
    expect(all.items.map((e: { name: string }) => e.name)).not.toContain('io.github.bob/files'); // package-only: hidden by default
    expect(all.items.map((e: { name: string }) => e.name)).not.toContain('io.github.mallory/evil');
    const w = all.items.find((e: { name: string }) => e.name === 'com.example/weather');
    expect(w).toMatchObject({ version: '1.0.0', title: 'Weather', transport: 'streamable_http', trust: 'verified', confidence: 'low', grade: 'A', hasRemote: true, inGateway: null, checkedAt: null });
    const b = all.items.find((e: { name: string }) => e.name === 'com.example/billing');
    expect(b).toMatchObject({ trust: 'mismatch', topFlag: { code: 'domain_mismatch' } });
    const n = all.items.find((e: { name: string }) => e.name === 'io.github.alice/notes');
    expect(n).toMatchObject({ trust: 'known', transport: 'streamable_http' }); // Streamable HTTP preferred over SSE
    // five publishers with one copied description: capped at D, sorted last
    for (const e of all.items.filter((x: { name: string }) => x.name.startsWith('io.github.s'))) expect(e).toMatchObject({ grade: 'D', topFlag: { code: 'duplicate_description' } });
    expect(all.items[0].grade).toBe('A');

    expect((await list('?remoteOnly=false')).items.find((e: { name: string }) => e.name === 'io.github.bob/files')).toMatchObject({ hasRemote: false, hasPackages: true, transport: null });
    expect((await list('?minGrade=B')).items.every((e: { grade: string }) => e.grade === 'A' || e.grade === 'B')).toBe(true);
    expect((await list('?trust=verified')).items.map((e: { name: string }) => e.name)).toEqual(['com.example/weather']);
  });

  it('keyword search over name, title, description and repository; paging by cursor', async () => {
    await enable();
    await ctx.s.library.sync();
    expect((await list('?q=forecast')).items.map((e: { name: string }) => e.name)).toEqual(['com.example/weather']);
    expect((await list('?q=invoice')).items.map((e: { name: string }) => e.name)).toEqual(['com.example/billing']); // prefix match on the last term
    expect((await list('?q=alice')).items.map((e: { name: string }) => e.name)).toEqual(['io.github.alice/notes']);
    expect((await list('?q=zzzz')).items).toEqual([]);
    const p1 = await list('?limit=3&sort=name');
    expect(p1.items).toHaveLength(3);
    const p2 = await list(`?limit=3&sort=name&cursor=${p1.nextCursor}`);
    expect(p2.items[0].name > p1.items[2].name).toBe(true);
  });

  it('incremental sync applies updates and deletions; a weekly full crawl drops entries the registry no longer lists', async () => {
    await enable();
    await ctx.s.library.sync();
    clock.advance(3_600_000);
    incremental = [rec('com.example/weather', { version: '1.1.0', title: 'Weather Pro', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }] }), { ...lookalike, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted', isLatest: true } } }];
    requests.length = 0;
    expect(await ctx.s.library.sync()).toBe('ok');
    expect(requests).toEqual([`/v0.1/servers?limit=100&updated_since=${encodeURIComponent(new Date(T0 - 600_000).toISOString())}`]);
    const items = (await list()).items;
    expect(items.find((e: { name: string }) => e.name === 'com.example/weather')).toMatchObject({ version: '1.1.0', title: 'Weather Pro' });
    expect(items.find((e: { name: string }) => e.name === 'com.example/billing')).toBeUndefined();

    clock.advance(8 * 86_400_000);
    pages = [[weather]];
    expect(await ctx.s.library.sync()).toBe('ok');
    // (the web session expired with the clock jump; read the status directly)
    expect(await ctx.s.library.status()).toMatchObject({ sync: { mode: 'full' }, counts: { total: 1 } });
  });

  it('a failed page keeps the cursor; the next run resumes the crawl', async () => {
    await enable();
    failSecondPage = true;
    await expect(ctx.s.library.sync()).rejects.toThrow('HTTP 503');
    const st = (await ctx.as(admin, { method: 'GET', url: '/api/library/status' })).json();
    expect(st.sync).toMatchObject({ running: false, lastError: 'The registry answered HTTP 503', pages: 1 });
    failSecondPage = false;
    requests.length = 0;
    expect(await ctx.s.library.sync()).toBe('ok');
    expect(requests).toEqual(['/v0.1/servers?limit=100&version=latest&cursor=1']);
    expect((await ctx.as(admin, { method: 'GET', url: '/api/library/status' })).json().counts.total).toBe(9);
  });

  it('check: connects without credentials, lints the tools, reads GitHub, and regrades with high confidence', async () => {
    await enable();
    await ctx.s.library.sync();
    const id = (await list('?q=weather')).items[0].id;
    const before = (await ctx.as(admin, { method: 'GET', url: `/api/library/${id}` })).json();
    expect(before).toMatchObject({ check: null, quality: { confidence: 'low', sources: ['registry'] }, draft: { name: 'Weather', slug: 'weather', url: 'https://mcp.example.com/mcp', transport: 'streamable_http', auth: { type: 'none' }, tags: ['library'], notes: [] } });
    expect(before.sourceUrl).toBe(`${REG}/v0.1/servers/com.example%2Fweather/versions/latest`);

    const res = await ctx.as(admin, { method: 'POST', url: `/api/library/${id}/check` });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json();
    expect(d.check.connection).toMatchObject({ ok: true, authRequired: false, toolCount: 2, serverInfo: { name: 'fake-upstream' }, error: null });
    expect(d.check.tools.map((t: { name: string; score: number }) => [t.name, t.score])).toEqual([['get_forecast', 0.9], ['x', 0.1]]);
    expect(d.check.github).toMatchObject({ repo: 'example/weather-mcp', found: true, stars: 820, license: 'Apache-2.0', ownerType: 'Organization' });
    expect(d.quality.sources).toEqual(['registry', 'check', 'definitions', 'github']);
    expect(d.quality.confidence).toBe('high');
    expect(d.quality.subscores.find((s: { key: string }) => s.key === 'definitions').score).toBeLessThan(0.5); // the bad tool drags it down
    expect(d.checkedAt).not.toBeNull();
    expect((await list('?q=weather')).items[0]).toMatchObject({ confidence: 'high', grade: d.quality.grade });
  });

  it('check: an endpoint that requires sign-in with OAuth discovery is neutral; Add-to-gateway maps the declared header', async () => {
    await enable();
    await ctx.s.library.sync();
    const id = (await list('?q=billing')).items[0].id;
    const d = (await ctx.as(admin, { method: 'POST', url: `/api/library/${id}/check` })).json();
    expect(d.check.connection).toMatchObject({ ok: false, authRequired: true, oauthDiscovery: true });
    expect(d.quality.flags.map((f: { code: string }) => f.code)).toEqual(['domain_mismatch']);
    expect(d.draft).toMatchObject({ auth: { type: 'shared_header', headerName: 'X-API-Key' }, notes: ['X-API-Key: API key from the dashboard settings page'] });

    const sse = (await list('?q=notes')).items[0].id;
    const notes = (await ctx.as(admin, { method: 'POST', url: `/api/library/${sse}/check` })).json();
    expect(notes.check.connection).toMatchObject({ ok: false, error: expect.stringContaining('ECONNREFUSED') });
    expect(notes.quality.flags.map((f: { code: string }) => f.code)).toContain('unreachable');
  });

  it('hide, Add to gateway (provenance), and the grade of a registered server', async () => {
    await enable();
    await ctx.s.library.sync();
    const id = (await list('?q=weather')).items[0].id;
    expect((await ctx.as(admin, { method: 'PATCH', url: `/api/library/${id}`, payload: { hidden: true } })).json().hidden).toBe(true);
    expect((await list('?q=weather')).items).toEqual([]);
    expect((await list('?q=weather&includeHidden=true')).items).toHaveLength(1);
    await ctx.as(admin, { method: 'PATCH', url: `/api/library/${id}`, payload: { hidden: false } });

    const created = await ctx.as(admin, {
      method: 'POST',
      url: '/api/servers',
      payload: { name: 'Weather', slug: 'weather', ownerId: admin.id, url: 'https://mcp.example.com/mcp', transport: 'streamable_http', auth: { type: 'none' }, libraryEntryId: id },
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = created.json().id;
    expect((await list('?q=weather')).items[0].inGateway).toEqual({ id: serverId, name: 'Weather' });
    // the next draft avoids the taken slug
    expect((await ctx.as(admin, { method: 'GET', url: `/api/library/${id}` })).json().draft.slug).toBe('weather-2');

    const q = await ctx.as(admin, { method: 'GET', url: `/api/servers/${serverId}/quality` });
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json()).toMatchObject({ version: 1, trust: 'verified', sources: ['registry', 'gateway'] });
    expect((await ctx.as(alice, { method: 'GET', url: `/api/servers/${serverId}/quality` })).statusCode).toBe(404);
  });
});
