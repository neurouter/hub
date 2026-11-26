import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { inputRequired } from '@modelcontextprotocol/server';
import { META_RETRY_AFTER_MS } from '@neurouter/shared';
import { FakeUpstream } from '../../test-utils/fake-upstream.js';
import { createTestContext, type TestContext, type TestUser } from '../test/fakes/context.js';
import { injectFetch } from '../test/fakes/inject-fetch.js';

describe('/mcp gateway', () => {
  let ctx: TestContext;
  let up: FakeUpstream;
  let admin: TestUser;
  let owner: TestUser;
  let alice: TestUser;
  let serverId: string;
  let tools: Record<string, string>;
  let apiKey: string;
  let agentId: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    up = new FakeUpstream({
      requireAuth: { header: 'authorization', value: 'Bearer up-secret' },
      tools: [
        { name: 'create_issue', description: 'Create a GitHub issue in a repository', inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'Repository' }, title: { type: 'string' } }, required: ['repo', 'title'] } },
        { name: 'delete_repo', description: 'Delete a GitHub repository permanently', inputSchema: { type: 'object', properties: { repo: { type: 'string' } } } },
        { name: 'list_issues', description: 'List issues in a repository', inputSchema: { type: 'object', properties: { repo: { type: 'string' } } } },
        { name: 'ask_name', description: 'Asks the user for a name', inputSchema: { type: 'object' } },
      ],
    });
    ctx = await createTestContext({ upstreamFetch: () => up.fetch });
    admin = await ctx.user('admin@x.test', ['admin']);
    owner = await ctx.user('owner@x.test');
    alice = await ctx.user('alice@x.test');
    const created = await ctx.as(admin, { method: 'POST', url: '/api/servers', payload: { name: 'GitHub', slug: 'github', ownerId: owner.id, url: 'http://upstream.test/mcp', transport: 'streamable_http', auth: { type: 'shared_bearer', token: 'up-secret' }, autoApproveNewTools: true } });
    serverId = created.json().id;
    await ctx.s.jobs.idle();
    owner = await ctx.user('owner@x.test'); // refresh owned servers in a new session
    const list = (await ctx.as(owner, { method: 'GET', url: '/api/tools' })).json().items as { id: string; name: string }[];
    tools = Object.fromEntries(list.map((t) => [t.name, t.id]));
    const agent = (await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'bot' } })).json();
    agentId = agent.id;
    apiKey = (await ctx.as(alice, { method: 'POST', url: `/api/agents/${agent.id}/keys`, payload: { name: 'k', expiresAt: null } })).json().secret;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await ctx.close();
    await up.close();
  });

  const grant = async (subject: { type: string; id: string }, target: { type: string; id: string }, effect: 'allow' | 'deny' = 'allow') => {
    const r = await ctx.as(owner, { method: 'POST', url: '/api/grants', payload: { subject, target, effect } });
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  };

  async function connect(opts: { token?: string; mode?: 'auto' | 'legacy'; elicit?: boolean } = {}) {
    const c = new Client({ name: 'test-client', version: '9.9' }, { versionNegotiation: { mode: opts.mode ?? 'auto' }, capabilities: opts.elicit ? { elicitation: { form: {} } } : {} });
    if (opts.elicit) c.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { name: 'Ada' } }));
    await c.connect(new StreamableHTTPClientTransport(new URL('http://gw.test/mcp'), { fetch: injectFetch(ctx.app), requestInit: { headers: { authorization: `Bearer ${opts.token ?? apiKey}` } } }));
    clients.push(c);
    return c;
  }

  it('serves PRM and challenges unauthenticated requests (401 + WWW-Authenticate)', async () => {
    const prm = (await ctx.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' })).json();
    expect(prm).toEqual({ resource: 'http://gw.test/mcp', authorization_servers: ['http://gw.test'], scopes_supported: ['mcp:tools'], bearer_methods_supported: ['header'], resource_name: 'Neurouter Hub' });
    const none = await ctx.app.inject({ method: 'POST', url: '/mcp', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer resource_metadata="http://gw.test/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"');
    const bad = await ctx.app.inject({ method: 'POST', url: '/mcp', payload: '{}', headers: { 'content-type': 'application/json', authorization: 'Bearer nr_live_0123456789_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['www-authenticate']).toContain('error="invalid_token"');
    const query = await ctx.app.inject({ method: 'POST', url: `/mcp?access_token=${apiKey}`, payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(query.statusCode).toBe(401);
  });

  it('rejects foreign Origins (403) and allows the gateway origin', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/mcp', payload: '{}', headers: { 'content-type': 'application/json', origin: 'https://evil.test', authorization: `Bearer ${apiKey}` } });
    expect(res.statusCode).toBe(403);
    const ok = await ctx.app.inject({ method: 'POST', url: '/mcp', payload: '{}', headers: { 'content-type': 'application/json', origin: 'http://gw.test', authorization: `Bearer ${apiKey}` } });
    expect(ok.statusCode).not.toBe(403);
  });

  it('modern client: tools/list is exactly the meta-tools (private cache); granted tools work; ungranted look unknown', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'tool', id: tools.create_issue! });
    const c = await connect();
    expect(c.getProtocolEra()).toBe('modern');
    const listed = await c.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['search_tools', 'call_tool']);
    expect(listed).toMatchObject({ ttlMs: 60000, cacheScope: 'private' });

    const r = await c.callTool({ name: 'call_tool', arguments: { name: 'github__create_issue', arguments: { repo: 'a/b', title: 'hi' } } });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: '{"repo":"a/b","title":"hi"}' }]);
    // direct call by exposed name has identical ACL
    expect((await c.callTool({ name: 'github__create_issue', arguments: { repo: 'a', title: 't' } })).isError).toBeFalsy();
    await expect(c.callTool({ name: 'github__delete_repo', arguments: { repo: 'a' } })).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('Unknown tool: github__delete_repo') });
    await expect(c.callTool({ name: 'github__nope', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    const viaMeta = await c.callTool({ name: 'call_tool', arguments: { name: 'github__delete_repo', arguments: {} } });
    expect(viaMeta).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('not found or not permitted') }] });

    // the upstream only ever saw the server credential, never the client's API key
    for (const req of up.requests) {
      expect(JSON.stringify(req)).not.toContain(apiKey);
      expect(req.headers.authorization).toBe('Bearer up-secret');
    }
  });

  it('search_tools ranks only allowed tools (a forbidden top match never appears)', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    await grant({ type: 'user', id: alice.id }, { type: 'tool', id: tools.delete_repo! }, 'deny');
    const c = await connect();
    const r = await c.callTool({ name: 'search_tools', arguments: { query: 'delete repository' } });
    const sc = r.structuredContent as { tools: { name: string; server: string; inputSchema?: object }[]; totalAllowed: number };
    expect(sc.tools.map((t) => t.name)).not.toContain('github__delete_repo');
    expect(sc.totalAllowed).toBe(3);
    expect(sc.tools[0]).toMatchObject({ server: 'github', inputSchema: { type: 'object' } });
    const exact = (await c.callTool({ name: 'search_tools', arguments: { query: 'github__list_issues', limit: 1 } })).structuredContent as { tools: { name: string }[] };
    expect(exact.tools.map((t) => t.name)).toEqual(['github__list_issues']);
    const none = await c.callTool({ name: 'search_tools', arguments: { query: 'zzzz' } });
    expect((none.content as { text: string }[])[0]!.text).toMatch(/No matching tools/);
  });

  it('deny overrides allow; group grants apply; agent narrowing restricts', async () => {
    const g = (await ctx.as(admin, { method: 'POST', url: '/api/groups', payload: { name: 'eng' } })).json();
    await ctx.as(admin, { method: 'POST', url: `/api/groups/${g.id}/members`, payload: { userIds: [alice.id] } });
    await grant({ type: 'group', id: g.id }, { type: 'server', id: serverId });
    const c = await connect();
    expect((await c.callTool({ name: 'github__list_issues', arguments: {} })).isError).toBeFalsy();
    await grant({ type: 'agent', id: agentId }, { type: 'tool', id: tools.list_issues! }, 'deny');
    await expect(c.callTool({ name: 'github__list_issues', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    // narrowing: only create_issue
    const scope = await ctx.as(alice, { method: 'PUT', url: `/api/agents/${agentId}/scope`, payload: { mode: 'restricted', serverIds: [], toolIds: [tools.create_issue] } });
    expect(scope.statusCode, scope.body).toBe(200);
    const access = (await ctx.as(alice, { method: 'GET', url: `/api/agents/${agentId}/access` })).json();
    expect(Object.fromEntries(access.servers[0].tools.map((t: { tool: { name: string }; decision: string }) => [t.tool.name, t.decision]))).toEqual({ create_issue: 'allow', delete_repo: 'none', list_issues: 'deny', ask_name: 'none' });
    await expect(c.callTool({ name: 'github__delete_repo', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    expect((await c.callTool({ name: 'github__create_issue', arguments: { repo: 'r', title: 't' } })).isError).toBeFalsy();
  });

  it('validates arguments against the pinned schema; rejects meta recursion', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    const c = await connect();
    const r = await c.callTool({ name: 'call_tool', arguments: { name: 'github__create_issue', arguments: { repo: 5 } } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/Invalid arguments[\s\S]*title/);
    expect(up.calls).toHaveLength(0);
    expect((await c.callTool({ name: 'call_tool', arguments: { name: 'call_tool', arguments: {} } })).isError).toBe(true);
  });

  it('rate limits per agent with retry-after', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    await ctx.s.dbs.main.db.updateTable('agents').set({ rate_limit: JSON.stringify({ perMinute: 2, burst: 2 }) }).where('id', '=', agentId).execute();
    ctx.s.authenticator.clearCache();
    const c = await connect();
    const call = () => c.callTool({ name: 'github__list_issues', arguments: {} });
    expect((await call()).isError).toBeFalsy();
    expect((await call()).isError).toBeFalsy();
    const limited = await call();
    expect(limited).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Rate limit exceeded for github__list_issues; retry after \d+s/) }] });
    expect((limited._meta as Record<string, number>)[META_RETRY_AFTER_MS]).toBeGreaterThan(0);
  });

  it('legacy (2025-11-25) clients are served statelessly', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    const c = await connect({ mode: 'legacy' });
    expect(c.getProtocolEra()).toBe('legacy');
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['search_tools', 'call_tool']);
    expect((await c.callTool({ name: 'call_tool', arguments: { name: 'github__list_issues', arguments: { repo: 'x' } } })).content).toEqual([{ type: 'text', text: '{"repo":"x"}' }]);
  });

  it('revoking the API key cuts access immediately (bus evicts the auth cache)', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    const c = await connect();
    expect((await c.callTool({ name: 'github__list_issues', arguments: {} })).isError).toBeFalsy();
    const key = (await ctx.as(alice, { method: 'GET', url: `/api/agents/${agentId}/keys` })).json().items[0];
    await ctx.as(alice, { method: 'DELETE', url: `/api/agents/${agentId}/keys/${key.id}` });
    await new Promise((r) => setTimeout(r, 5));
    await expect(c.callTool({ name: 'github__list_issues', arguments: {} })).rejects.toThrow();
  });

  async function pendingApproval(): Promise<{ id: string; timeoutSec: number; inputParams: Record<string, unknown>; actions: string[] }> {
    for (let i = 0; i < 200; i++) {
      const items = (await ctx.as(owner, { method: 'GET', url: '/api/approvals?status=pending' })).json().items;
      if (items.length) return items[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('no pending approval appeared');
  }

  /** A second replica: same database, its own (unconnected) coordination store, so only the DB poll links them. */
  async function secondReplica() {
    const { createServices, initServices } = await import('../deps.js');
    const { buildApp } = await import('../app.js');
    const { apiPlugins } = await import('../api/plugin.js');
    const { MemoryCoordination } = await import('../coordination/memory.js');
    const { disabledEmbedder } = await import('../search/embedder.js');
    const s2 = createServices({ config: ctx.s.config, logger: ctx.s.logger, dbs: ctx.s.dbs, clock: ctx.clock, coordination: new MemoryCoordination(ctx.clock), version: 't', defaultMetrics: false, archive: null, oidcProvider: null, embedder: disabledEmbedder(), upstreamFetch: () => up.fetch, outboundFetch: async () => new Response('', { status: 502 }) });
    await initServices(s2);
    const app2 = await buildApp({ config: ctx.s.config, logger: ctx.s.logger, dbs: ctx.s.dbs, auditStore: s2.auditStore, clock: ctx.clock, version: 't', apiPlugins: apiPlugins(s2) });
    await app2.ready();
    return { s2, app2, close: async () => { await app2.close(); await s2.shutdown(); } };
  }

  it('requires_approval: the call is held, an owner approves on ANOTHER replica, and the call completes', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    await ctx.as(owner, { method: 'PATCH', url: `/api/tools/${tools.delete_repo}`, payload: { requiresApproval: true } });
    const r2 = await secondReplica();
    try {
      const c = await connect();
      const call = c.callTool({ name: 'call_tool', arguments: { name: 'github__delete_repo', arguments: { repo: 'acme/old', token: 'ghp_' + 'a'.repeat(36) } } });
      const pending = await pendingApproval();
      expect(up.calls).toHaveLength(0);
      expect(pending).toMatchObject({ timeoutSec: 300, actions: ['approve', 'deny'], inputParams: { repo: 'acme/old', token: { $redacted: expect.any(String) } } });
      // the requesting user cannot approve their own agent's call
      expect((await ctx.as(alice, { method: 'POST', url: `/api/approvals/${pending.id}/approve`, payload: {} })).statusCode).toBe(403);
      const ok = await r2.app2.inject({ method: 'POST', url: `/api/approvals/${pending.id}/approve`, headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': 'application/json' }, payload: { note: 'fine' } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ status: 'approved', decidedBy: { id: owner.id }, actions: [] });
      const r = await call;
      expect(r.isError).toBeFalsy();
      expect(up.calls).toHaveLength(1);
      // second decision → 409
      expect((await ctx.as(owner, { method: 'POST', url: `/api/approvals/${pending.id}/deny`, payload: { reason: 'late' } })).statusCode).toBe(409);
      await ctx.s.auditStore.flush();
      const from = new Date(Date.now() - 3_600_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();
      const events = (await ctx.as(admin, { method: 'GET', url: `/api/audit/events?from=${from}&to=${to}&kind=tool_call` })).json().items as { decision: string }[];
      expect(events.map((e) => e.decision).sort()).toEqual(['approval_pending', 'approved']);
    } finally {
      await r2.close();
    }
  }, 15_000);

  it('requires_approval: deny returns isError with the approver and reason; timeouts expire', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    await ctx.as(owner, { method: 'PATCH', url: `/api/tools/${tools.delete_repo}`, payload: { requiresApproval: true } });
    const c = await connect();
    const call = c.callTool({ name: 'github__delete_repo', arguments: { repo: 'x' } });
    const pending = await pendingApproval();
    expect((await ctx.as(owner, { method: 'POST', url: `/api/approvals/${pending.id}/deny`, payload: { reason: 'not today' } })).statusCode).toBe(200);
    expect(await call).toMatchObject({ isError: true, content: [{ text: 'Denied by owner: not today' }] });
    expect(up.calls).toHaveLength(0);

    await ctx.s.settings.set('approvalDefaultTimeoutSec', 1);
    const timed = await c.callTool({ name: 'github__delete_repo', arguments: { repo: 'y' } });
    expect(timed).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Approval timed out after 1s/) }] });
    const resolved = (await ctx.as(owner, { method: 'GET', url: '/api/approvals?status=resolved' })).json().items as { status: string }[];
    expect(resolved.map((a) => a.status).sort()).toEqual(['denied', 'expired']);
    expect(up.calls).toHaveLength(0);
  }, 15_000);

  async function expectCancelled(approvalId: string) {
    let status = '';
    for (let i = 0; i < 300 && status !== 'cancelled'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = (await ctx.as(owner, { method: 'GET', url: `/api/approvals/${approvalId}` })).json().status;
    }
    expect(status).toBe('cancelled');
  }

  it('requires_approval: a modern client aborting its request stream cancels the held approval (real socket)', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    await ctx.as(owner, { method: 'PATCH', url: `/api/tools/${tools.delete_repo}`, payload: { requiresApproval: true } });
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const c = new Client({ name: 'socket-client', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
    clients.push(c);
    expect(c.getProtocolEra()).toBe('modern');
    const ac = new AbortController();
    const call = c.callTool({ name: 'github__delete_repo', arguments: { repo: 'x' } }, { signal: ac.signal }).then(
      () => 'resolved',
      () => 'rejected',
    );
    const pending = await pendingApproval();
    ac.abort('user pressed Esc');
    expect(await call).toBe('rejected');
    await expectCancelled(pending.id);
    expect(up.calls).toHaveLength(0);
  }, 15_000);

  it('requires_approval: a legacy client cancel (notifications/cancelled on a separate POST) cancels the held approval', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    await ctx.as(owner, { method: 'PATCH', url: `/api/tools/${tools.delete_repo}`, payload: { requiresApproval: true } });
    const c = await connect({ mode: 'legacy' });
    const ac = new AbortController();
    // injectFetch ignores the signal, so only the cancel notification can reach the gateway
    const call = c.callTool({ name: 'github__delete_repo', arguments: { repo: 'x' } }, { signal: ac.signal }).then(
      () => 'resolved',
      () => 'rejected',
    );
    const pending = await pendingApproval();
    ac.abort('user pressed Esc');
    expect(await call).toBe('rejected');
    await expectCancelled(pending.id);
    expect(up.calls).toHaveLength(0);
  }, 15_000);

  it('legacy clients: tool calls are attributed to the clientInfo sent in initialize', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    const c = await connect({ mode: 'legacy' });
    await c.callTool({ name: 'github__list_issues', arguments: { repo: 'x' } });
    await ctx.s.auditStore.flush();
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const events = (await ctx.as(admin, { method: 'GET', url: `/api/audit/events?from=${from}&to=${to}&kind=tool_call` })).json().items as { client: unknown; protocolVersion?: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.client).toMatchObject({ name: 'test-client', version: '9.9' });
  });

  it('changed (rug-pulled) tools are blocked until re-approved', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    up.tools[2]!.description = 'evil';
    await ctx.s.toolSync.sync(serverId, 'manual');
    const c = await connect();
    await expect(c.callTool({ name: 'github__list_issues', arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });

  it('upstream failures become isError results; timeouts too', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    await ctx.as(owner, { method: 'PATCH', url: `/api/servers/${serverId}`, payload: { timeoutMs: 1000 } });
    const c = await connect();
    up.delayMs = 1500;
    const r = await c.callTool({ name: 'github__list_issues', arguments: {} });
    expect(r).toMatchObject({ isError: true, content: [{ text: 'Server GitHub did not respond in time' }] });
  }, 10_000);

  it('MRTR: an upstream input_required round-trips through the gateway with a wrapped requestState', async () => {
    await grant({ type: 'user', id: alice.id }, { type: 'server', id: serverId });
    const seenState: unknown[] = [];
    // patch the upstream server: intercept tools/call for ask_name at the fetch level
    const realFetch = up.fetch;
    let round = 0;
    (up as unknown as { fetch: typeof up.fetch }).fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const text = req.method === 'POST' ? await req.clone().text() : '';
      const body = text ? JSON.parse(text) : null;
      if (body?.method === 'tools/call' && body.params?.name === 'ask_name') {
        seenState.push(body.params.requestState ?? null);
        round++;
        const result = round === 1
          ? inputRequired({ inputRequests: { q: inputRequired.elicit({ message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }) }, requestState: 'UPSTREAM-STATE' })
          : { content: [{ type: 'text', text: `hello ${JSON.stringify(body.params.inputResponses)}` }] };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ...result, ...(round === 1 ? {} : { resultType: 'complete' }) } }), { headers: { 'content-type': 'application/json' } });
      }
      return realFetch(req);
    };
    ctx.s.pool.invalidate(serverId);
    const c = await connect({ elicit: true });
    const r = await c.callTool({ name: 'call_tool', arguments: { name: 'github__ask_name', arguments: {} } });
    expect(r.content).toEqual([{ type: 'text', text: 'hello {"q":{"action":"accept","content":{"name":"Ada"}}}' }]);
    // the upstream got its own state back; the client only ever saw the wrapped one
    expect(seenState).toEqual([null, 'UPSTREAM-STATE']);
  });
});
