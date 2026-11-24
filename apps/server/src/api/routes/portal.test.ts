import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { FakeUpstream } from '../../../test-utils/fake-upstream.js';
import { newId } from '../../lib/ids.js';
import { PortalCatalogService, pageAfter } from '../../portal/catalog.service.js';
import { ConnectionsService } from '../../portal/connections.service.js';
import { createTestContext, type TestContext, type TestUser } from '../../test/fakes/context.js';
import { injectFetch } from '../../test/fakes/inject-fetch.js';

describe('portal: catalog, access requests, connections', () => {
  let ctx: TestContext;
  let up: FakeUpstream;
  let admin: TestUser;
  let owner: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let gh: string;
  let wiki: string;
  let tools: Record<string, string>;
  const clients: Client[] = [];

  beforeEach(async () => {
    up = new FakeUpstream({
      tools: [
        { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object' } },
        { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object' } },
      ],
    });
    ctx = await createTestContext({ upstreamFetch: () => up.fetch });
    admin = await ctx.user('admin@x.test', ['admin']);
    owner = await ctx.user('owner@x.test');
    alice = await ctx.user('alice@x.test');
    bob = await ctx.user('bob@x.test');
    const mk = async (slug: string, tags: string[], ownerId: string) =>
      (await ctx.as(admin, { method: 'POST', url: '/api/servers', payload: { name: slug.toUpperCase(), slug, tags, ownerId, url: `http://${slug}.test/mcp`, transport: 'streamable_http', auth: { type: 'none' }, autoApproveNewTools: true } })).json().id as string;
    gh = await mk('github', ['dev', 'vcs'], owner.id);
    wiki = await mk('wiki', ['docs'], admin.id);
    await ctx.s.jobs.idle();
    owner = await ctx.user('owner@x.test');
    const list = (await ctx.as(owner, { method: 'GET', url: `/api/tools?serverId=${gh}` })).json().items as { id: string; name: string }[];
    tools = Object.fromEntries(list.map((t) => [t.name, t.id]));
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await ctx.close();
    await up.close();
  });

  const grant = async (subject: { type: string; id: string }, target: { type: string; id: string }, effect = 'allow', by = owner) => {
    const r = await ctx.as(by, { method: 'POST', url: '/api/grants', payload: { subject, target, effect } });
    expect(r.statusCode, r.body).toBe(201);
  };

  it('lists servers with per-user access, health, connection and tags; filters; tool detail', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'tool', id: tools.create_issue! });
    const res = (await ctx.as(alice, { method: 'GET', url: '/api/catalog/servers' })).json();
    expect(res.items.map((s: { slug: string; access: string; toolCount: number; connection: string }) => [s.slug, s.access, s.toolCount, s.connection])).toEqual([
      ['github', 'partial', 2, 'not_required'],
      ['wiki', 'none', 2, 'not_required'],
    ]);
    expect(res.items[0]).toMatchObject({ owner: { id: owner.id }, tags: ['dev', 'vcs'], health: { status: expect.any(String) }, authType: 'none' });
    expect((await ctx.as(alice, { method: 'GET', url: '/api/catalog/servers?access=granted' })).json().items.map((s: { slug: string }) => s.slug)).toEqual(['github']);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/catalog/servers?tag=docs' })).json().items.map((s: { slug: string }) => s.slug)).toEqual(['wiki']);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/catalog/servers?q=git' })).json().items).toHaveLength(1);
    const byCount = await ctx.as(alice, { method: 'GET', url: '/api/catalog/servers?sort=toolCount&limit=1' });
    expect(byCount.json().nextCursor).toBeTruthy();
    expect((await ctx.as(alice, { method: 'GET', url: `/api/catalog/servers?sort=toolCount&limit=1&cursor=${byCount.json().nextCursor}` })).json().items).toHaveLength(1);

    const detail = (await ctx.as(alice, { method: 'GET', url: `/api/catalog/servers/${gh}` })).json();
    expect(Object.fromEntries(detail.tools.map((t: { name: string; access: string }) => [t.name, t.access]))).toEqual({ create_issue: 'allowed', list_issues: 'none' });
    expect(detail.tools[0]).toMatchObject({ qualifiedName: 'github__create_issue', inputSchema: { type: 'object' }, requiresApproval: false });
    expect((await ctx.as(alice, { method: 'GET', url: `/api/catalog/servers/${newId()}` })).statusCode).toBe(404);

    const tags = (await ctx.as(alice, { method: 'GET', url: '/api/catalog/tags' })).json();
    expect(tags.tags).toEqual([{ name: 'dev', count: 1 }, { name: 'docs', count: 1 }, { name: 'vcs', count: 1 }]);

    const toolsPage = (await ctx.as(alice, { method: 'GET', url: '/api/catalog/tools' })).json();
    expect(toolsPage.items.map((t: { qualifiedName: string; access: string; score: number | null }) => [t.qualifiedName, t.access, t.score])).toEqual([
      ['github__create_issue', 'allowed', null],
      ['github__list_issues', 'none', null],
      ['wiki__create_issue', 'none', null],
      ['wiki__list_issues', 'none', null],
    ]);
    const searched = (await ctx.as(alice, { method: 'GET', url: `/api/catalog/tools?q=list&serverId=${gh}` })).json();
    expect(searched.items.map((t: { qualifiedName: string }) => t.qualifiedName)).toEqual(['github__list_issues']);
    expect(searched.items[0].score).toBeGreaterThan(0);
    expect(searched.suggestion).toBeNull();
    // nothing found → "Did you mean" from the visible tools' words
    const typo = (await ctx.as(alice, { method: 'GET', url: '/api/catalog/tools?q=isseus' })).json();
    expect(typo.items).toEqual([]);
    expect(typo.suggestion).toBe('issues');
    const nothing = (await ctx.as(alice, { method: 'GET', url: '/api/catalog/tools?q=zzzzzzzz' })).json();
    expect(nothing).toMatchObject({ items: [], suggestion: null });
  });

  it('deny shows as denied; with catalogVisibility=granted only accessible servers are listed', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: gh });
    await grant({ type: 'user', id: alice.id }, { type: 'tool', id: tools.list_issues! }, 'deny');
    const d = (await ctx.as(alice, { method: 'GET', url: `/api/catalog/servers/${gh}` })).json();
    expect(Object.fromEntries(d.tools.map((t: { name: string; access: string }) => [t.name, t.access]))).toEqual({ create_issue: 'allowed', list_issues: 'denied' });
    await ctx.s.settings.set('catalogVisibility', 'granted');
    expect((await ctx.as(alice, { method: 'GET', url: '/api/catalog/servers' })).json().items.map((s: { slug: string }) => s.slug)).toEqual(['github']);
    expect((await ctx.as(alice, { method: 'GET', url: `/api/catalog/servers/${wiki}` })).statusCode).toBe(404);
    expect((await ctx.as(bob, { method: 'GET', url: '/api/catalog/servers' })).json().items).toEqual([]);
  });

  it('request → owner approves → grant appears → the agent can call immediately', async () => {
    const agent = (await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'bot' } })).json();
    const key = (await ctx.as(alice, { method: 'POST', url: `/api/agents/${agent.id}/keys`, payload: { name: 'k', expiresAt: null } })).json().secret;
    const c = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(new StreamableHTTPClientTransport(new URL('http://gw.test/mcp'), { fetch: injectFetch(ctx.app), requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    clients.push(c);
    await expect(c.callTool({ name: 'github__list_issues', arguments: {} })).rejects.toMatchObject({ code: -32602 });

    expect((await ctx.as(alice, { method: 'POST', url: '/api/access-requests', payload: { target: { type: 'server', id: gh }, reason: 'short' } })).statusCode).toBe(422);
    const created = await ctx.as(alice, { method: 'POST', url: '/api/access-requests', payload: { target: { type: 'server', id: gh }, reason: 'I triage issues for the team', agentId: agent.id } });
    expect(created.statusCode, created.body).toBe(201);
    const req = created.json();
    expect(req).toMatchObject({ requester: { id: alice.id }, agent: { id: agent.id, name: 'bot' }, target: { type: 'server', id: gh, name: 'GITHUB', server: { id: gh } }, status: 'pending' });
    expect((await ctx.as(alice, { method: 'POST', url: '/api/access-requests', payload: { target: { type: 'server', id: gh }, reason: 'I triage issues for the team', agentId: agent.id } })).statusCode).toBe(409);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/catalog/servers' })).json().items.find((s: { id: string }) => s.id === gh).access).toBe('pending');
    expect((await ctx.as(alice, { method: 'GET', url: '/api/me/badges' })).json().myPendingRequests).toBe(1);
    expect((await ctx.as(owner, { method: 'GET', url: '/api/me/badges' })).json().pendingAccessRequests).toBe(1);

    // review queue: owner sees it, a non-owner can't review, a foreign serverId is 403
    expect((await ctx.as(owner, { method: 'GET', url: '/api/access-requests' })).json().items.map((r: { id: string }) => r.id)).toEqual([req.id]);
    expect((await ctx.as(owner, { method: 'GET', url: `/api/access-requests?serverId=${wiki}` })).statusCode).toBe(403);
    expect((await ctx.as(bob, { method: 'GET', url: '/api/access-requests' })).statusCode).toBe(403);
    expect((await ctx.as(bob, { method: 'POST', url: `/api/access-requests/${req.id}/approve`, payload: {} })).statusCode).toBe(404); // not a reviewer: no enumeration
    // narrowing to a tool of another server is rejected
    expect((await ctx.as(owner, { method: 'POST', url: `/api/access-requests/${req.id}/approve`, payload: { target: { type: 'server', id: wiki } } })).statusCode).toBe(422);

    const approved = await ctx.as(owner, { method: 'POST', url: `/api/access-requests/${req.id}/approve`, payload: { target: { type: 'tool', id: tools.list_issues }, note: 'ok' } });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().request).toMatchObject({ status: 'approved', reviewer: { id: owner.id }, note: 'ok', grantId: approved.json().grant.id });
    expect(approved.json().grant).toMatchObject({ source: 'access_request', accessRequestId: req.id, subject: { type: 'user', id: alice.id }, target: { type: 'tool', id: tools.list_issues } });
    expect((await ctx.as(owner, { method: 'POST', url: `/api/access-requests/${req.id}/approve`, payload: {} })).statusCode).toBe(409);
    // the queue's Resolved tab: decided requests only (the default is still pending)
    expect((await ctx.as(owner, { method: 'GET', url: '/api/access-requests' })).json().items).toEqual([]);
    expect((await ctx.as(owner, { method: 'GET', url: '/api/access-requests?status=resolved' })).json().items.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([[req.id, 'approved']]);

    // immediately callable (ACL snapshot invalidated)
    expect((await c.callTool({ name: 'github__list_issues', arguments: {} })).isError).toBeFalsy();
    const mine = (await ctx.as(alice, { method: 'GET', url: '/api/me/access-requests' })).json();
    expect(mine.items[0]).toMatchObject({ status: 'approved' });
    await ctx.s.auditStore.flush();
    const now = Date.now();
    const evs = (await ctx.as(owner, { method: 'GET', url: `/api/audit/events?from=${new Date(now - 60_000).toISOString()}&to=${new Date(now + 60_000).toISOString()}&kind=admin` })).json().items.map((e: { adminAction: string }) => e.adminAction);
    expect(evs).toEqual(expect.arrayContaining(['access_request.create', 'access_request.approve', 'grant.create']));
  });

  it('deny with a note, cancel own pending requests, already-allowed → 409', async () => {
    const r1 = (await ctx.as(alice, { method: 'POST', url: '/api/access-requests', payload: { target: { type: 'tool', id: tools.create_issue }, reason: 'need it for work' } })).json();
    expect((await ctx.as(owner, { method: 'POST', url: `/api/access-requests/${r1.id}/deny`, payload: { note: '' } })).statusCode).toBe(422);
    const denied = await ctx.as(owner, { method: 'POST', url: `/api/access-requests/${r1.id}/deny`, payload: { note: 'not now' } });
    expect(denied.json()).toMatchObject({ status: 'denied', note: 'not now' });
    expect((await ctx.as(alice, { method: 'DELETE', url: `/api/me/access-requests/${r1.id}` })).statusCode).toBe(409);
    const r2 = (await ctx.as(alice, { method: 'POST', url: '/api/access-requests', payload: { target: { type: 'tool', id: tools.create_issue }, reason: 'need it for work' } })).json();
    expect((await ctx.as(bob, { method: 'DELETE', url: `/api/me/access-requests/${r2.id}` })).statusCode).toBe(404);
    expect((await ctx.as(alice, { method: 'DELETE', url: `/api/me/access-requests/${r2.id}` })).statusCode).toBe(204);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/me/access-requests?status=cancelled' })).json().items.map((r: { id: string }) => r.id)).toEqual([r2.id]);
    const decided = (await ctx.as(admin, { method: 'GET', url: '/api/access-requests?status=denied' })).json();
    expect(decided.items.map((r: { id: string }) => r.id)).toEqual([r1.id]);
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: gh });
    expect((await ctx.as(alice, { method: 'POST', url: '/api/access-requests', payload: { target: { type: 'server', id: gh }, reason: 'need it for work' } })).statusCode).toBe(409);
    expect((await ctx.as(alice, { method: 'POST', url: '/api/access-requests', payload: { target: { type: 'server', id: newId() }, reason: 'need it for work' } })).statusCode).toBe(422);
  });

  it('lists per-user OAuth connections for accessible servers and disconnects', async () => {
    const db = ctx.s.dbs.main.db;
    await db.updateTable('servers').set({ auth_mode: 'user_oauth' }).where('id', '=', gh).execute();
    await ctx.s.acl.catalogChanged();
    expect((await ctx.as(alice, { method: 'GET', url: '/api/me/connections' })).json()).toEqual({ items: [] });
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: gh });
    const before = (await ctx.as(alice, { method: 'GET', url: '/api/me/connections' })).json().items;
    expect(before).toEqual([{ server: { id: gh, name: 'GITHUB' }, status: 'not_connected', accountLabel: null, scopes: [], connectedAt: null, expiresAt: null, error: null }]);
    const dek = await ctx.s.envelope.activeDek();
    const now = Date.now();
    await db.insertInto('user_upstream_tokens').values({ id: newId(), user_id: alice.id, server_id: gh, issuer: 'https://as.test', dek_id: dek.id, access_nonce: Buffer.alloc(12), access_ct: Buffer.alloc(16), refresh_nonce: null, refresh_ct: null, token_type: 'Bearer', scopes: 'repo read:org', expires_at: now + 3_600_000, status: 'active', refreshed_at: null, created_at: now, updated_at: now }).execute();
    const conn = (await ctx.as(alice, { method: 'GET', url: '/api/me/connections' })).json().items[0];
    expect(conn).toMatchObject({ status: 'connected', scopes: ['repo', 'read:org'] });
    expect((await ctx.as(alice, { method: 'GET', url: '/api/catalog/servers' })).json().items.find((s: { id: string }) => s.id === gh)).toMatchObject({ authType: 'per_user_oauth', connection: 'connected' });
    expect((await ctx.as(alice, { method: 'DELETE', url: `/api/me/connections/${gh}` })).statusCode).toBe(204);
    expect((await ctx.as(alice, { method: 'DELETE', url: `/api/me/connections/${gh}` })).statusCode).toBe(404);
    expect(ConnectionsService.status({ status: 'refresh_failed', expires_at: null, refresh_ct: null }, now)).toBe('error');
    expect(ConnectionsService.status({ status: 'active', expires_at: now - 1, refresh_ct: null }, now)).toBe('expired');
    expect(ConnectionsService.status({ status: 'active', expires_at: now - 1, refresh_ct: Buffer.alloc(1) }, now)).toBe('connected');
  });

  it('server access states and in-memory keyset paging', () => {
    expect(PortalCatalogService.serverAccess(['allowed', 'allowed'], 'none', false)).toBe('granted');
    expect(PortalCatalogService.serverAccess(['allowed', 'none'], 'none', true)).toBe('partial');
    expect(PortalCatalogService.serverAccess(['none'], 'none', true)).toBe('pending');
    expect(PortalCatalogService.serverAccess([], 'allow', false)).toBe('granted');
    expect(PortalCatalogService.serverAccess(['denied'], 'deny', false)).toBe('none');
    const items = ['a', 'b', 'c', 'd'].map((k) => ({ k }));
    const p1 = pageAfter(items, undefined, 2, (x) => [x.k, x.k]);
    expect(p1.items.map((x) => x.k)).toEqual(['a', 'b']);
    expect(pageAfter(items, p1.nextCursor!, 2, (x) => [x.k, x.k])).toEqual({ items: [{ k: 'c' }, { k: 'd' }], nextCursor: null });
    const desc = [...items].reverse();
    const d1 = pageAfter(desc, undefined, 3, (x) => [x.k, x.k], true);
    expect(pageAfter(desc, d1.nextCursor!, 3, (x) => [x.k, x.k], true).items).toEqual([{ k: 'a' }]);
  });

  it('client-config snippet data for the "Connect a client" page', async () => {
    expect((await ctx.as(alice, { method: 'GET', url: '/api/portal/client-config' })).json()).toEqual({ mcpUrl: 'http://gw.test/mcp', oauthSupported: true, protocolVersions: ['2026-07-28', '2025-11-25'], serverName: 'neurouter', apiKeyHeader: 'Authorization: Bearer' });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/portal/client-config' })).statusCode).toBe(401);
  });
});
