import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeUpstream } from '../../../test-utils/fake-upstream.js';
import { createTestContext, type TestContext, type TestUser } from '../../test/fakes/context.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf000000ff00fb03fd2c2c0b0000000049454e44ae426082', 'hex');

describe('catalog REST', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let owner: TestUser;
  let auditor: TestUser;
  let alice: TestUser;
  const ups = new Map<string, FakeUpstream>();
  const up = (url: string) => ups.get(new URL(url).host) ?? ups.get('default')!;

  beforeEach(async () => {
    ups.clear();
    ups.set('default', new FakeUpstream({ requireAuth: { header: 'authorization', value: 'Bearer up-secret' } }));
    ctx = await createTestContext({
      upstreamFetch: (server) => (input, init) => up(server.url).fetch(input, init),
      outboundFetch: async (u) => (String(u) === 'https://icons.test/a.png' ? new Response(PNG) : new Response('<html>', { status: 200 })),
    });
    admin = await ctx.user('admin@x.test', ['admin']);
    owner = await ctx.user('owner@x.test');
    auditor = await ctx.user('aud@x.test', ['auditor']);
    alice = await ctx.user('alice@x.test');
  });
  afterEach(async () => {
    await ctx.close();
    for (const u of ups.values()) await u.close();
  });

  async function createServer(over: Record<string, unknown> = {}) {
    const res = await ctx.as(admin, {
      method: 'POST',
      url: '/api/servers',
      payload: { name: 'GitHub', slug: 'github', ownerId: owner.id, url: 'http://upstream.test/mcp', transport: 'streamable_http', auth: { type: 'shared_bearer', token: 'up-secret' }, tags: ['dev'], ...over },
    });
    expect(res.statusCode, res.body).toBe(201);
    await ctx.s.jobs.idle();
    return res.json();
  }

  it('registers a server: secret encrypted at rest, never returned; initial sync lists tools pending review', async () => {
    const created = await createServer({ iconUrl: 'https://icons.test/a.png' });
    expect(created).toMatchObject({ slug: 'github', authType: 'shared_bearer', owner: { id: owner.id }, auth: { type: 'shared_bearer', hasSecret: true } });
    expect(JSON.stringify(created)).not.toContain('up-secret');
    const secret = await ctx.s.dbs.main.db.selectFrom('secrets').selectAll().executeTakeFirstOrThrow();
    expect(secret.ciphertext!.includes(Buffer.from('up-secret'))).toBe(false);

    const job = (await ctx.as(admin, { method: 'GET', url: `/api/jobs/${created.initialSync.jobId}` })).json();
    expect(job).toMatchObject({ kind: 'tool_sync', status: 'succeeded', result: { added: 1, changed: 0, removed: 0, unchanged: 0 } });
    expect((await ctx.as(alice, { method: 'GET', url: `/api/jobs/${created.initialSync.jobId}` })).statusCode).toBe(404);

    const detail = (await ctx.as(owner, { method: 'GET', url: `/api/servers/${created.id}` })).json();
    expect(detail).toMatchObject({ detectedEra: 'modern', protocolVersion: '2026-07-28', serverInfo: { name: 'fake-upstream', version: '1.0.0' }, toolCount: 1, pendingReviewCount: 1, enabledToolCount: 0, health: { status: 'up' }, iconUrl: expect.stringMatching(new RegExp(`^/api/servers/${created.id}/icon\\?v=[\\w-]+$`)) });
    expect(detail.actions).toEqual(['update', 'sync', 'health_check', 'manage_grants', 'refresh_icon']);

    const tools = (await ctx.as(owner, { method: 'GET', url: '/api/tools' })).json().items;
    expect(tools).toMatchObject([{ qualifiedName: 'github__echo', reviewState: 'pending_review', enabled: false, upstreamPresent: true }]);

    // icon proxy: same-origin bytes with ETag and a sandboxing CSP
    const icon = await ctx.as(alice, { method: 'GET', url: `/api/servers/${created.id}/icon` });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toBe('image/png');
    expect(icon.headers['content-security-policy']).toContain('sandbox');
    expect(icon.rawPayload.equals(PNG)).toBe(true);
    const again = await ctx.as(alice, { method: 'GET', url: `/api/servers/${created.id}/icon`, headers: { 'if-none-match': String(icon.headers.etag) } });
    expect(again.statusCode).toBe(304);
    // the versioned URL the API hands out is served too
    expect((await ctx.as(alice, { method: 'GET', url: detail.iconUrl })).statusCode).toBe(200);
    // removing the override re-fetches at once: no advertised icon → no iconUrl
    const cleared = await ctx.as(owner, { method: 'PATCH', url: `/api/servers/${created.id}`, payload: { iconUrl: null } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().iconUrl).toBeNull();
  });

  it('approve pins the hash; an upstream change blocks the tool until re-approved', async () => {
    const s = await createServer();
    const tool = (await ctx.as(owner, { method: 'GET', url: '/api/tools' })).json().items[0];
    const diff = (await ctx.as(owner, { method: 'GET', url: `/api/tools/${tool.id}/definition-diff` })).json();
    expect(diff.pinned).toBeNull();
    expect((await ctx.as(owner, { method: 'PATCH', url: `/api/tools/${tool.id}`, payload: { enabled: true } })).statusCode).toBe(409);
    expect((await ctx.as(owner, { method: 'POST', url: `/api/tools/${tool.id}/approve-definition`, payload: { hash: 'stale' } })).statusCode).toBe(409);
    const approved = (await ctx.as(owner, { method: 'POST', url: `/api/tools/${tool.id}/approve-definition`, payload: { hash: diff.current.hash } })).json();
    expect(approved).toMatchObject({ reviewState: 'approved', enabled: true, pinnedHash: diff.current.hash, pinnedBy: { id: owner.id }, hasPendingChange: false });

    // rug pull: the upstream changes the description
    up('http://upstream.test').tools[0]!.description = 'Now exfiltrates data';
    const sync = (await ctx.as(owner, { method: 'POST', url: `/api/servers/${s.id}/sync` })).json();
    await ctx.s.jobs.idle();
    expect((await ctx.as(owner, { method: 'GET', url: `/api/jobs/${sync.jobId}` })).json().result).toEqual({ added: 0, changed: 1, removed: 0, unchanged: 0 });
    const changed = (await ctx.as(owner, { method: 'GET', url: `/api/tools/${tool.id}` })).json();
    expect(changed).toMatchObject({ reviewState: 'pending_review', hasPendingChange: true, description: 'Echo the input text' });
    const row = await ctx.s.dbs.main.db.selectFrom('tools').select('status').where('id', '=', tool.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('changed');
    const d2 = (await ctx.as(owner, { method: 'GET', url: `/api/tools/${tool.id}/definition-diff` })).json();
    expect(d2.pinned.description).toBe('Echo the input text');
    expect(d2.current.description).toBe('Now exfiltrates data');

    // reject keeps it blocked; a sync with the same definition stays rejected
    expect((await ctx.as(owner, { method: 'POST', url: `/api/tools/${tool.id}/reject-definition`, payload: { note: 'no' } })).json().reviewState).toBe('rejected');
    await ctx.as(owner, { method: 'POST', url: `/api/servers/${s.id}/sync` });
    await ctx.s.jobs.idle();
    expect((await ctx.as(owner, { method: 'GET', url: `/api/tools/${tool.id}` })).json().reviewState).toBe('rejected');

    // reverting upstream restores the pinned definition
    up('http://upstream.test').tools[0]!.description = 'Echo the input text';
    await ctx.as(owner, { method: 'POST', url: `/api/servers/${s.id}/sync` });
    await ctx.s.jobs.idle();
    expect((await ctx.as(owner, { method: 'GET', url: `/api/tools/${tool.id}` })).json().reviewState).toBe('approved');

    // removed upstream
    up('http://upstream.test').tools = [];
    await ctx.as(owner, { method: 'POST', url: `/api/servers/${s.id}/sync` });
    await ctx.s.jobs.idle();
    expect((await ctx.as(owner, { method: 'GET', url: `/api/tools/${tool.id}` })).json().upstreamPresent).toBe(false);

    const versions = (await ctx.as(auditor, { method: 'GET', url: `/api/tools/${tool.id}/versions` })).json().items;
    expect(versions.map((v: { decision: string }) => v.decision).sort()).toEqual(['approved', 'rejected']);
    const runs = (await ctx.as(auditor, { method: 'GET', url: `/api/servers/${s.id}/sync-runs?limit=2` })).json();
    expect(runs.items).toHaveLength(2);
    expect(runs.nextCursor).not.toBeNull();
  });

  it('auto-approve applies to new tools only; invalid x-mcp-header tools never get in', async () => {
    up('http://upstream.test').tools.push({ name: 'bad', inputSchema: { type: 'object', properties: { a: { type: 'object', 'x-mcp-header': 'A' } } } });
    const s = await createServer({ autoApproveNewTools: true });
    const tools = (await ctx.as(owner, { method: 'GET', url: '/api/tools' })).json().items;
    expect(tools).toMatchObject([{ name: 'echo', reviewState: 'approved', enabled: true }]);
    // the SDK client already drops tools with invalid x-mcp-header (spec MUST); the sync re-checks it
    expect(tools.map((t: { name: string }) => t.name)).toEqual(['echo']);
    up('http://upstream.test').tools[0]!.description = 'changed';
    await ctx.as(owner, { method: 'POST', url: `/api/servers/${s.id}/sync` });
    await ctx.s.jobs.idle();
    expect((await ctx.as(owner, { method: 'GET', url: '/api/tools?status=pending_review' })).json().items).toHaveLength(1);
  });

  it('owner vs admin field rules, slug immutability, scoping and guards', async () => {
    const s = await createServer();
    expect((await ctx.as(owner, { method: 'PATCH', url: `/api/servers/${s.id}`, payload: { name: 'GH', timeoutMs: 30000 } })).json()).toMatchObject({ name: 'GH', timeoutMs: 30000 });
    expect((await ctx.as(owner, { method: 'PATCH', url: `/api/servers/${s.id}`, payload: { url: 'http://evil.test/mcp' } })).statusCode).toBe(403);
    expect((await ctx.as(admin, { method: 'PATCH', url: `/api/servers/${s.id}`, payload: { slug: 'gh' } })).statusCode).toBe(409);
    expect((await ctx.as(admin, { method: 'PATCH', url: `/api/servers/${s.id}`, payload: { url: 'http://169.254.169.254/latest' } })).statusCode).toBe(422);
    expect((await ctx.as(alice, { method: 'GET', url: `/api/servers/${s.id}` })).statusCode).toBe(403);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/servers' })).statusCode).toBe(403);
    expect((await ctx.as(auditor, { method: 'GET', url: '/api/servers' })).json().items).toHaveLength(1);
    expect((await ctx.as(auditor, { method: 'GET', url: `/api/servers/${s.id}` })).json().actions).toEqual([]);
    expect((await ctx.as(auditor, { method: 'POST', url: `/api/servers/${s.id}/sync` })).statusCode).toBe(403);
    expect((await ctx.as(owner, { method: 'POST', url: '/api/servers', payload: {} })).statusCode).toBe(403);
    expect((await ctx.as(admin, { method: 'POST', url: '/api/servers', payload: { name: 'x', slug: 'github', ownerId: owner.id, url: 'http://upstream.test/mcp', transport: 'streamable_http', auth: { type: 'none' } } })).statusCode).toBe(409);
    expect((await ctx.as(admin, { method: 'POST', url: '/api/servers', payload: { name: 'x', slug: 'Bad_Slug', ownerId: owner.id, url: 'http://upstream.test/mcp', transport: 'streamable_http', auth: { type: 'none' } } })).statusCode).toBe(422);

    // credentials: write-only; wrong kind → 409
    expect((await ctx.as(admin, { method: 'PUT', url: `/api/servers/${s.id}/credentials`, payload: { token: 'new-secret' } })).json()).toMatchObject({ hasSecret: true });
    expect((await ctx.as(admin, { method: 'PUT', url: `/api/servers/${s.id}/credentials`, payload: { headerValue: 'x' } })).statusCode).toBe(409);
    expect((await ctx.as(owner, { method: 'PUT', url: `/api/servers/${s.id}/credentials`, payload: { token: 'x' } })).statusCode).toBe(403);
    // the new secret is used: upstream rejects it now
    const hc = (await ctx.as(owner, { method: 'POST', url: `/api/servers/${s.id}/health-check` })).json();
    expect(hc.status).toBe('degraded');
    const hist = (await ctx.as(owner, { method: 'GET', url: `/api/servers/${s.id}/health` })).json();
    expect(hist.points.length).toBeGreaterThanOrEqual(2);

    // soft delete
    expect((await ctx.as(admin, { method: 'DELETE', url: `/api/servers/${s.id}` })).statusCode).toBe(204);
    expect((await ctx.as(admin, { method: 'GET', url: '/api/servers' })).json().items).toHaveLength(0);
  });

  it('test-connection: modern, legacy and SSE upstreams; bad credentials; stored secret reuse', async () => {
    ups.set('legacy.test', new FakeUpstream({ variant: 'legacy', name: 'old' }));
    ups.set('sse.test', new FakeUpstream({ variant: 'sse', name: 'sse' }));
    const tc = (payload: object) => ctx.as(admin, { method: 'POST', url: '/api/servers/test-connection', payload });
    expect((await tc({ url: 'http://upstream.test/mcp', transport: 'streamable_http', auth: { type: 'shared_bearer', token: 'up-secret' } })).json()).toMatchObject({ ok: true, era: 'modern', toolCount: 1, error: null });
    expect((await tc({ url: 'http://upstream.test/mcp', transport: 'streamable_http', auth: { type: 'none' } })).json()).toMatchObject({ ok: false, authRequired: true, error: { code: 'auth_required' } });
    expect((await tc({ url: 'http://legacy.test/mcp', transport: 'streamable_http', auth: { type: 'none' } })).json()).toMatchObject({ ok: true, era: 'legacy', protocolVersion: '2025-11-25', serverInfo: { name: 'old' } });
    expect((await tc({ url: 'http://sse.test/sse', transport: 'sse', auth: { type: 'none' } })).json()).toMatchObject({ ok: true, era: 'legacy_sse', toolCount: 1 });
    const s = await createServer();
    expect((await ctx.as(owner, { method: 'POST', url: '/api/servers/test-connection', payload: { url: 'http://upstream.test/mcp', transport: 'streamable_http', auth: { type: 'shared_bearer' }, serverId: s.id } })).json().ok).toBe(true);
    expect((await ctx.as(owner, { method: 'POST', url: '/api/servers/test-connection', payload: { url: 'http://upstream.test/mcp', transport: 'streamable_http', auth: { type: 'none' } } })).statusCode).toBe(403);
  });

  it('registers a legacy SSE server and syncs over it', async () => {
    ups.set('sse.test', new FakeUpstream({ variant: 'sse' }));
    const s = await createServer({ slug: 'legacy-sse', url: 'http://sse.test/sse', transport: 'sse', auth: { type: 'none' } });
    expect((await ctx.as(owner, { method: 'GET', url: `/api/servers/${s.id}` })).json()).toMatchObject({ detectedEra: 'legacy_sse', toolCount: 1 });
  });

  it('tools: bulk update skips pending tools; filters', async () => {
    await createServer({ autoApproveNewTools: true });
    up('http://upstream.test').tools.push({ name: 'two' });
    const s2 = (await ctx.as(admin, { method: 'GET', url: '/api/servers' })).json().items[0];
    await ctx.as(owner, { method: 'PATCH', url: `/api/servers/${s2.id}`, payload: { autoApproveNewTools: false } });
    await ctx.as(owner, { method: 'POST', url: `/api/servers/${s2.id}/sync` });
    await ctx.s.jobs.idle();
    const all = (await ctx.as(owner, { method: 'GET', url: '/api/tools' })).json().items;
    const res = (await ctx.as(owner, { method: 'POST', url: '/api/tools/bulk', payload: { ids: all.map((t: { id: string }) => t.id), patch: { enabled: true, requiresApproval: true } } })).json();
    expect(res.updated).toBe(1);
    expect(res.skipped).toMatchObject([{ reason: 'pending_review' }]);
    expect((await ctx.as(owner, { method: 'GET', url: '/api/tools?requiresApproval=true' })).json().items).toHaveLength(1);
    expect((await ctx.as(owner, { method: 'GET', url: '/api/tools?q=two' })).json().items).toHaveLength(1);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/tools' })).statusCode).toBe(403);
  });
});
