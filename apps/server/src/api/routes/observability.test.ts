import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AUDIT_EXPORT_TRUNCATED_HEADER } from '@neurouter/shared';
import { FakeUpstream } from '../../../test-utils/fake-upstream.js';
import { createTestContext, type TestContext, type TestUser } from '../../test/fakes/context.js';
import { injectFetch } from '../../test/fakes/inject-fetch.js';
import { loadUserSubject } from '../../identity/principal.js';

const range = () => {
  const now = Date.now();
  return `from=${encodeURIComponent(new Date(now - 3_600_000).toISOString())}&to=${encodeURIComponent(new Date(now + 3_600_000).toISOString())}`;
};

describe('audit, metrics and sessions REST (+ gateway → audit → rollups)', () => {
  let ctx: TestContext;
  let up: FakeUpstream;
  let admin: TestUser;
  let auditor: TestUser;
  let owner: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let serverId: string;
  let otherServerId: string;
  let apiKey: string;
  let agentId: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    up = new FakeUpstream({ tools: [{ name: 'search_docs', description: 'Search documents', inputSchema: { type: 'object', properties: { query: { type: 'string' }, password: { type: 'string' } } } }] });
    ctx = await createTestContext({ upstreamFetch: () => up.fetch });
    admin = await ctx.user('admin@x.test', ['admin']);
    auditor = await ctx.user('auditor@x.test', ['auditor']);
    owner = await ctx.user('owner@x.test');
    alice = await ctx.user('alice@x.test');
    bob = await ctx.user('bob@x.test');
    const mk = async (slug: string, ownerId: string) => (await ctx.as(admin, { method: 'POST', url: '/api/servers', payload: { name: slug, slug, ownerId, url: `http://${slug}.test/mcp`, transport: 'streamable_http', auth: { type: 'none' }, autoApproveNewTools: true } })).json().id as string;
    serverId = await mk('docs', owner.id);
    otherServerId = await mk('other', admin.id);
    await ctx.s.jobs.idle();
    owner = await ctx.user('owner@x.test');
    const agent = (await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'bot' } })).json();
    agentId = agent.id;
    apiKey = (await ctx.as(alice, { method: 'POST', url: `/api/agents/${agent.id}/keys`, payload: { name: 'k', expiresAt: null } })).json().secret;
    const r = await ctx.as(owner, { method: 'POST', url: '/api/grants', payload: { subject: { type: 'user', id: alice.id }, target: { type: 'server', id: serverId }, effect: 'allow' } });
    expect(r.statusCode, r.body).toBe(201);
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await ctx.close();
    await up.close();
  });

  async function connect(headers: Record<string, string> = {}) {
    const c = new Client({ name: 'test-client', version: '1.0' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(new StreamableHTTPClientTransport(new URL('http://gw.test/mcp'), { fetch: injectFetch(ctx.app), requestInit: { headers: { authorization: `Bearer ${apiKey}`, ...headers } } }));
    clients.push(c);
    return c;
  }

  async function callSome() {
    const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const c = await connect();
    const ok = await c.callTool({ name: 'docs__search_docs', arguments: { query: 'quarterly plan', password: 'hunter2' }, _meta: { traceparent: tp } });
    expect(ok.isError).toBeFalsy();
    await expect(c.callTool({ name: 'other__search_docs', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    await ctx.s.auditStore.flush();
    await ctx.s.rollups.flush();
    return { tp };
  }

  it('records every call and admin change; propagates trace context upstream; redacts params', async () => {
    const { tp } = await callSome();
    // upstream saw the caller's trace id with a gateway span id in _meta.traceparent
    const call = up.requestsFor('tools/call')[0]!;
    const sent = (call.body as { params: { _meta: Record<string, string> } }).params._meta.traceparent!;
    expect(sent.split('-')[1]).toBe(tp.split('-')[1]);
    expect(sent.split('-')[2]).not.toBe(tp.split('-')[2]);

    const res = await ctx.as(auditor, { method: 'GET', url: `/api/audit/events?${range()}&kind=tool_call` });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as { id: string; decision: string; status: string; tool: { qualifiedName: string } | null; server: { slug: string } | null; agent: { name: string }; traceId: string | null; sessionId: string | null }[];
    expect(items.map((i) => [i.tool?.qualifiedName, i.decision, i.status])).toEqual([
      ['other__search_docs', 'denied_acl', 'blocked'],
      ['docs__search_docs', 'allowed', 'ok'],
    ]);
    expect(items[1]).toMatchObject({ server: { slug: 'docs' }, agent: { name: 'bot' }, traceId: tp.split('-')[1] });
    expect(items[1]!.sessionId).toBeTruthy();
    const full = (await ctx.as(auditor, { method: 'GET', url: `/api/audit/events/${items[1]!.id}` })).json();
    expect(full.inputParams).toEqual({ query: 'quarterly plan', password: { $redacted: 'sensitive-key' } });
    expect(full.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(full.hash).toMatch(/^[0-9a-f]{64}$/);
    // admin changes are audited too (server.create, grant.create…)
    const admins = (await ctx.as(auditor, { method: 'GET', url: `/api/audit/events?${range()}&kind=admin&limit=100` })).json().items as { adminAction: string; id: string }[];
    expect(admins.map((a) => a.adminAction)).toEqual(expect.arrayContaining(['server.create', 'grant.create', 'agent.create']));
    const grantEv = admins.find((a) => a.adminAction === 'grant.create')!;
    const gd = (await ctx.as(auditor, { method: 'GET', url: `/api/audit/events/${grantEv.id}` })).json();
    expect(gd.admin).toMatchObject({ action: 'grant.create', target: { type: 'grant' } });
    // FTS over the allow-listed param keys; redacted values are not findable
    expect((await ctx.as(auditor, { method: 'GET', url: `/api/audit/events?${range()}&q=quarterly` })).json().items).toHaveLength(1);
    expect((await ctx.as(auditor, { method: 'GET', url: `/api/audit/events?${range()}&q=hunter2` })).json().items).toHaveLength(0);
  });

  it('requires a bounded time range (422) and pages with an opaque cursor', async () => {
    await ctx.s.auditStore.flush();
    expect((await ctx.as(auditor, { method: 'GET', url: '/api/audit/events' })).statusCode).toBe(422);
    const long = `from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z`;
    expect((await ctx.as(auditor, { method: 'GET', url: `/api/audit/events?${long}` })).statusCode).toBe(422);
    const p1 = (await ctx.as(auditor, { method: 'GET', url: `/api/audit/events?${range()}&limit=2` })).json();
    expect(p1.items).toHaveLength(2);
    const p2 = (await ctx.as(auditor, { method: 'GET', url: `/api/audit/events?${range()}&limit=2&cursor=${p1.nextCursor}` })).json();
    expect(p2.items[0].seq).toBeLessThan(p1.items[1].seq);
    expect((await ctx.as(auditor, { method: 'GET', url: `/api/audit/events?${range()}&cursor=garbage` })).statusCode).toBe(422);
  });

  it('owners are forced to owned servers (403 on a foreign serverId); users see only their own rows', async () => {
    await callSome();
    expect((await ctx.as(owner, { method: 'GET', url: `/api/audit/events?${range()}&serverId=${otherServerId}` })).statusCode).toBe(403);
    const ownerRows = (await ctx.as(owner, { method: 'GET', url: `/api/audit/events?${range()}&limit=200` })).json().items as { server: { id: string } | null }[];
    expect(ownerRows.length).toBeGreaterThan(0);
    expect(ownerRows.every((r) => r.server?.id === serverId)).toBe(true);
    const mine = (await ctx.as(alice, { method: 'GET', url: `/api/audit/events?${range()}&limit=200&userId=${owner.id}` })).json().items as { user: { id: string } | null }[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.user?.id === alice.id)).toBe(true);
    expect((await ctx.as(bob, { method: 'GET', url: `/api/audit/events?${range()}` })).json().items).toEqual([]);
    const someId = (await ctx.as(alice, { method: 'GET', url: `/api/audit/events?${range()}` })).json().items[0].id;
    expect((await ctx.as(bob, { method: 'GET', url: `/api/audit/events/${someId}` })).statusCode).toBe(404);
    // export: forbidden for plain users
    expect((await ctx.as(alice, { method: 'GET', url: `/api/audit/export?${range()}&format=csv` })).statusCode).toBe(403);
    // metrics are scoped the same way
    const m = (await ctx.as(owner, { method: 'GET', url: `/api/metrics/summary?${range()}` })).json();
    expect(m.calls).toBe(1);
    expect((await ctx.as(owner, { method: 'GET', url: `/api/metrics/summary?${range()}&serverId=${otherServerId}` })).statusCode).toBe(403);
    expect((await ctx.as(bob, { method: 'GET', url: `/api/metrics/summary?${range()}` })).json().calls).toBe(0);
    expect((await ctx.as(alice, { method: 'GET', url: `/api/metrics/summary?${range()}&scope=me` })).json().calls).toBe(2);
  });

  it('exports CSV and NDJSON (streamed, audited, truncation header when capped)', async () => {
    await callSome();
    const csv = await ctx.as(auditor, { method: 'GET', url: `/api/audit/export?${range()}&format=csv&kind=tool_call` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="neurouter-audit-.*\.csv"/);
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toMatch(/^seq,id,ts,kind/);
    expect(lines).toHaveLength(3);
    expect(csv.headers[AUDIT_EXPORT_TRUNCATED_HEADER.toLowerCase()]).toBeUndefined();
    const nd = await ctx.as(auditor, { method: 'GET', url: `/api/audit/export?${range()}&format=json&kind=tool_call` });
    expect(nd.body.trim().split('\n').map((l) => JSON.parse(l).kind)).toEqual(['tool_call', 'tool_call']);
    await ctx.s.auditStore.flush();
    const exports = (await ctx.as(auditor, { method: 'GET', url: `/api/audit/events?${range()}&kind=admin&limit=200` })).json().items.filter((e: { adminAction: string }) => e.adminAction === 'audit.export');
    expect(exports).toHaveLength(2);
    // the cap: count > cap sets the header
    const reply = { headers: {} as Record<string, string>, header(k: string, v: string) { this.headers[k] = v; return this; }, status() { return this; }, send() { return this; } };
    const viewer = (await loadUserSubject(ctx.s.dbs.main.db, auditor.id))!;
    await ctx.s.auditService.export({ from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString(), format: 'json' }, viewer, reply as never, { ip: '127.0.0.1', userAgent: null }, 1);
    expect(reply.headers[AUDIT_EXPORT_TRUNCATED_HEADER]).toBe('true');
  });

  it('verify runs as a job and reports ok, then the tampered seq', async () => {
    await callSome();
    const start = await ctx.as(auditor, { method: 'POST', url: '/api/audit/verify', payload: {} });
    expect(start.statusCode, start.body).toBe(202);
    await ctx.s.jobs.idle();
    const job = (await ctx.as(auditor, { method: 'GET', url: `/api/jobs/${start.json().jobId}` })).json();
    expect(job).toMatchObject({ kind: 'audit_verify', status: 'succeeded', result: { ok: true, brokenAt: null } });
    expect(job.result.checked).toBeGreaterThan(3);
    await ctx.s.dbs.audit.db.updateTable('audit_log').set({ decision_reason: 'tampered' }).where('seq', '=', 2).execute();
    const again = await ctx.as(auditor, { method: 'POST', url: '/api/audit/verify', payload: { from: new Date(Date.now() - 3_600_000).toISOString() } });
    await ctx.s.jobs.idle();
    expect((await ctx.as(auditor, { method: 'GET', url: `/api/jobs/${again.json().jobId}` })).json().result).toMatchObject({ ok: false, brokenAt: { seq: 2, reason: 'hash_mismatch' } });
    expect((await ctx.as(owner, { method: 'POST', url: '/api/audit/verify', payload: {} })).statusCode).toBe(403);
  });

  it('metrics timeseries/breakdown and sessions with a per-minute chart and a timeline', async () => {
    await callSome();
    const ts = (await ctx.as(auditor, { method: 'GET', url: `/api/metrics/timeseries?${range()}&interval=1h` })).json();
    expect(ts.points.reduce((s: number, p: { calls: number }) => s + p.calls, 0)).toBe(2);
    const br = (await ctx.as(auditor, { method: 'GET', url: `/api/metrics/breakdown?${range()}&dimension=agent` })).json();
    expect(br.rows).toEqual([expect.objectContaining({ key: agentId, label: 'bot', calls: 2, blocked: 1 })]);
    const reasons = (await ctx.as(auditor, { method: 'GET', url: `/api/metrics/breakdown?${range()}&dimension=block_reason` })).json();
    expect(reasons.rows).toEqual([expect.objectContaining({ key: 'denied_acl', label: 'Not permitted', calls: 1 })]);

    const sessions = (await ctx.as(auditor, { method: 'GET', url: `/api/sessions?${range()}` })).json().items;
    const traced = sessions.find((s: { source: string }) => s.source === 'trace');
    expect(traced).toMatchObject({ agent: { id: agentId, name: 'bot' }, user: { id: alice.id }, callCount: 1, active: true, client: { name: 'test-client' } });
    const detail = (await ctx.as(auditor, { method: 'GET', url: `/api/sessions/${traced.id}` })).json();
    expect(detail.perMinute.reduce((s: number, p: { calls: number }) => s + p.calls, 0)).toBe(1);
    const timeline = (await ctx.as(auditor, { method: 'GET', url: `/api/sessions/${traced.id}/events` })).json();
    expect(timeline.items).toEqual([expect.objectContaining({ server: expect.objectContaining({ slug: 'docs' }), tool: { qualifiedName: 'docs__search_docs' }, decision: 'allowed', status: 'ok' })]);
    // scoping: bob sees no sessions and gets 404 on alice's
    expect((await ctx.as(bob, { method: 'GET', url: `/api/sessions?${range()}` })).json().items).toEqual([]);
    expect((await ctx.as(bob, { method: 'GET', url: `/api/sessions/${traced.id}` })).statusCode).toBe(404);
    expect((await ctx.as(owner, { method: 'GET', url: `/api/sessions/${traced.id}` })).statusCode).toBe(200);
    expect((await ctx.as(alice, { method: 'GET', url: `/api/sessions?${range()}&active=true` })).json().items.length).toBeGreaterThan(0);
  });

  it('/metrics exposes Prometheus metrics (no user/agent labels) and honours METRICS_TOKEN', async () => {
    await callSome();
    const res = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('neurouter_tool_calls_total{server="docs",tool="docs__search_docs",decision="allowed",status="ok"} 1');
    expect(res.body).toContain('neurouter_upstream_up{server="docs"}');
    expect(res.body).not.toMatch(/(user|agent)(_id)?="/);
    const locked = await createTestContext({ env: { METRICS_TOKEN: 'scrape-me' } });
    try {
      expect((await locked.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
      expect((await locked.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer scrape-me' } })).statusCode).toBe(200);
    } finally {
      await locked.close();
    }
  });

  it('fails closed: tool calls return an error while audit cannot accept events', async () => {
    const c = await connect();
    const orig = ctx.s.auditStore.canAccept.bind(ctx.s.auditStore);
    ctx.s.auditStore.canAccept = () => false;
    try {
      const r = await c.callTool({ name: 'docs__search_docs', arguments: { query: 'x' } });
      expect(r).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Audit logging is unavailable') }] });
      expect(up.requestsFor('tools/call')).toHaveLength(0);
    } finally {
      ctx.s.auditStore.canAccept = orig;
    }
  });
});
