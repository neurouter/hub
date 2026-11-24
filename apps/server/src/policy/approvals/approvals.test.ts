import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Approval } from '@neurouter/shared';
import { buildApp } from '../../app.js';
import { installWebAuth } from '../../auth/web/guards.js';
import { approvalRoutes } from '../../api/routes/approvals.js';
import type { McpPrincipal } from '../../auth/mcp/authenticate.js';
import type { RequestContext } from '../../gateway/context.js';
import { seedCatalog } from '../../test/fakes/catalog-builders.js';
import { createTestContext, type TestContext, type TestUser } from '../../test/fakes/context.js';
import { ApprovalHold } from './hold.js';
import { parseLastEventId, sseFrame, streamEventFor, streamEventId } from './stream.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('approvals', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let auditor: TestUser;
  let owner: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let serverId: string;
  let toolId: string;
  let agentId: string;
  let keyId: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    admin = await ctx.user('admin@x.test', ['admin']);
    auditor = await ctx.user('auditor@x.test', ['auditor']);
    alice = await ctx.user('alice@x.test');
    bob = await ctx.user('bob@x.test');
    const seeded = await seedCatalog(ctx.s.dbs.main.db, [{ slug: 'gh', tools: [{ name: 'delete_repo', description: 'Delete a repository', requiresApproval: true }] }]);
    serverId = seeded.servers.gh!;
    toolId = seeded.tools.gh__delete_repo!;
    const ownerRow = await ctx.s.dbs.main.db.selectFrom('users').select('email').where('id', '=', seeded.ownerId).executeTakeFirstOrThrow();
    owner = await ctx.user(ownerRow.email);
    agentId = (await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'bot' } })).json().id;
    keyId = (await ctx.as(alice, { method: 'POST', url: `/api/agents/${agentId}/keys`, payload: { name: 'ci-runner', expiresAt: null } })).json().key.id;
  });
  afterEach(async () => {
    await ctx.close();
  });

  const rc = (userId = alice.id): RequestContext => ({
    principal: { user: { id: userId, email: 'alice@x.test', name: 'alice' }, groupIds: [], agent: { id: agentId, name: 'bot', narrowed: false, rateLimit: null }, authMethod: 'api_key', credentialId: keyId, oauthClientId: null, scopes: ['mcp:tools'] } satisfies McpPrincipal,
    ip: '127.0.0.1',
    userAgent: null,
    traceparent: null,
    legacySessionId: null,
  });

  function hold(opts: { timeoutSec?: number; signal?: AbortSignal; progress?: (p: { progress: number; total: number; message: string }) => void } = {}) {
    const pending: { id: string; timeoutSec: number }[] = [];
    const h = new ApprovalHold({ db: ctx.s.dbs.main.db, clock: ctx.clock, coord: ctx.s.coord, settings: ctx.s.settings, approvals: ctx.s.approvals, instanceId: 'replica-a', redact: async (a) => a, heartbeatMs: 20, progressMs: 20, pollMs: 25 });
    const promise = h.hold(rc(), { requestId: 'r1', toolId, serverId, toolName: 'gh__delete_repo', args: { repo: 'x' }, timeoutSec: opts.timeoutSec ?? null, signal: opts.signal ?? new AbortController().signal, client: { name: 'claude-code', version: '2.0' }, onPending: (a) => pending.push(a), ...(opts.progress ? { progress: opts.progress } : {}) });
    return { promise, pending };
  }

  async function pendingId(): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const r = await ctx.s.dbs.main.db.selectFrom('approvals').select('id').where('status', '=', 'pending').executeTakeFirst();
      if (r) return r.id;
      await wait(5);
    }
    throw new Error('no pending approval');
  }

  it('hold → approve: payload has createdAt, timeoutSec, client and authMethod; approver gets the call through', async () => {
    const progress: number[] = [];
    const { promise, pending } = hold({ progress: (p) => progress.push(p.progress) });
    const id = await pendingId();
    expect(pending).toEqual([{ id, expiresAt: expect.any(Number), timeoutSec: 300 }]);
    const a = (await ctx.as(owner, { method: 'GET', url: `/api/approvals/${id}` })).json() as Approval;
    expect(a).toMatchObject({ status: 'pending', timeoutSec: 300, client: { name: 'claude-code', version: '2.0' }, authMethod: 'api_key', apiKey: { id: keyId, name: 'ci-runner' }, user: { id: alice.id }, agent: { id: agentId, name: 'bot' }, server: { id: serverId, slug: 'gh' }, tool: { name: 'delete_repo', qualifiedName: 'gh__delete_repo' }, inputParams: { repo: 'x' }, actions: ['approve', 'deny'] });
    expect(Date.parse(a.expiresAt) - Date.parse(a.createdAt)).toBe(300_000);
    await wait(50);
    const ok = await ctx.as(owner, { method: 'POST', url: `/api/approvals/${id}/approve`, payload: {} });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await promise).toEqual({ status: 'approved', approverId: owner.id, approvalId: id });
    expect(progress[0]).toBe(0);
    expect(progress.length).toBeGreaterThan(1);
    const row = await ctx.s.approvals.row(id);
    expect(Number(row!.heartbeat_at)).toBeGreaterThan(Number(row!.created_at) - 1);
  });

  it('eligibility: admins and the owner decide; auditors and other users cannot; self-approval needs allowSelfApproval', async () => {
    const { promise } = hold();
    const id = await pendingId();
    expect((await ctx.as(auditor, { method: 'POST', url: `/api/approvals/${id}/approve`, payload: {} })).statusCode).toBe(403);
    expect((await ctx.as(auditor, { method: 'GET', url: `/api/approvals/${id}` })).json().actions).toEqual([]);
    expect((await ctx.as(bob, { method: 'POST', url: `/api/approvals/${id}/approve`, payload: {} })).statusCode).toBe(404);
    expect((await ctx.as(bob, { method: 'GET', url: `/api/approvals/${id}` })).statusCode).toBe(404);
    // the caller sees their own pending call, read-only
    expect((await ctx.as(alice, { method: 'GET', url: `/api/approvals/${id}` })).json().actions).toEqual([]);
    // an admin who is also the calling user is blocked from self-approval
    await ctx.s.dbs.main.db.insertInto('user_roles').values({ user_id: alice.id, role: 'admin', source: 'local', created_at: Date.now(), created_by: null }).execute();
    const aliceAdmin = await ctx.user('alice@x.test');
    expect((await ctx.as(aliceAdmin, { method: 'POST', url: `/api/approvals/${id}/approve`, payload: {} })).statusCode).toBe(403);
    await ctx.s.settings.set('allowSelfApproval', true);
    expect((await ctx.as(aliceAdmin, { method: 'POST', url: `/api/approvals/${id}/deny`, payload: { reason: 'my own call' } })).statusCode).toBe(200);
    expect(await promise).toMatchObject({ status: 'denied', message: 'Denied by alice: my own call' });
    expect((await ctx.as(admin, { method: 'POST', url: `/api/approvals/${id}/approve`, payload: {} })).statusCode).toBe(409);
    // deny needs a reason
    expect((await ctx.as(admin, { method: 'POST', url: `/api/approvals/${id}/deny`, payload: {} })).statusCode).toBe(422);
  });

  it('lists are scoped: pending oldest first; users see only mine; owners cannot ask for foreign servers', async () => {
    const h1 = hold();
    await pendingId();
    await wait(5);
    const h2 = hold();
    await wait(30);
    const asOwner = (await ctx.as(owner, { method: 'GET', url: '/api/approvals?status=pending' })).json();
    expect(asOwner.items).toHaveLength(2);
    expect(Date.parse(asOwner.items[0].createdAt)).toBeLessThanOrEqual(Date.parse(asOwner.items[1].createdAt));
    const page1 = (await ctx.as(admin, { method: 'GET', url: '/api/approvals?status=pending&limit=1' })).json();
    expect(page1.items).toHaveLength(1);
    const page2 = (await ctx.as(admin, { method: 'GET', url: `/api/approvals?status=pending&limit=1&cursor=${page1.nextCursor}` })).json();
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect((await ctx.as(bob, { method: 'GET', url: '/api/approvals' })).json().items).toEqual([]);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/approvals?mine=true' })).json().items).toHaveLength(2);
    expect((await ctx.as(bob, { method: 'GET', url: `/api/approvals?serverId=${serverId}` })).statusCode).toBe(403);
    expect((await ctx.as(auditor, { method: 'GET', url: '/api/approvals?status=resolved' })).json().items).toEqual([]);
    for (const a of asOwner.items) await ctx.as(admin, { method: 'POST', url: `/api/approvals/${a.id}/deny`, payload: { reason: 'cleanup' } });
    await Promise.all([h1.promise, h2.promise]);
  });

  it('client abort cancels; timeout expires (capped by approvalMaxTimeoutSec); 410 after expiry', async () => {
    const ac = new AbortController();
    const c = hold({ signal: ac.signal });
    const id = await pendingId();
    ac.abort();
    expect(await c.promise).toMatchObject({ status: 'cancelled' });
    expect((await ctx.s.approvals.row(id))!.status).toBe('cancelled');
    expect((await ctx.as(owner, { method: 'POST', url: `/api/approvals/${id}/approve`, payload: {} })).statusCode).toBe(409);

    await ctx.s.settings.set('approvalMaxTimeoutSec', 1);
    const t = hold({ timeoutSec: 600 });
    const tid = await pendingId();
    expect(await t.promise).toMatchObject({ status: 'timeout', message: expect.stringContaining('timed out after 1s') });
    expect((await ctx.s.approvals.row(tid))!.status).toBe('expired');
    expect((await ctx.as(owner, { method: 'POST', url: `/api/approvals/${tid}/approve`, payload: {} })).statusCode).toBe(410);
  });

  it('janitor: a dead holder (no heartbeat for 60 s) is abandoned; overdue rows expire; both wake waiters', async () => {
    const now = Date.now();
    const base = { tool_id: toolId, server_id: serverId, agent_id: agentId, user_id: alice.id, audit_request_id: 'r', arguments_redacted: '{}', arguments_hash: 'h', held_by_instance: 'dead', decided_by: null, decided_at: null, reason: null, client_name: null, client_version: null, created_at: now - 120_000, updated_at: now - 120_000 };
    await ctx.s.dbs.main.db.insertInto('approvals').values([
      { ...base, id: '01900000-0000-7000-8000-00000000000a', heartbeat_at: now - 61_000, expires_at: now + 100_000 },
      { ...base, id: '01900000-0000-7000-8000-00000000000b', heartbeat_at: now - 1_000, expires_at: now - 1 },
      { ...base, id: '01900000-0000-7000-8000-00000000000c', heartbeat_at: now - 1_000, expires_at: now + 100_000 },
    ]).execute();
    const woken: unknown[] = [];
    ctx.s.coord.subscribe('approval:01900000-0000-7000-8000-00000000000a', (p) => woken.push(p));
    expect(await ctx.s.approvals.sweep(now)).toEqual({ abandoned: 1, expired: 1 });
    expect(woken).toEqual([{ status: 'abandoned', decidedBy: null, reason: null }]);
    const statuses = await ctx.s.dbs.main.db.selectFrom('approvals').select(['id', 'status']).orderBy('id').execute();
    expect(statuses.map((s) => s.status)).toEqual(['abandoned', 'expired', 'pending']);
    expect(await ctx.s.approvals.sweep(now)).toEqual({ abandoned: 0, expired: 0 });
  });

  it('SSE helpers: event names, ids and frames', () => {
    expect(streamEventFor('pending')).toBe('approval.created');
    expect(streamEventFor('approved')).toBe('approval.resolved');
    expect(streamEventFor('denied')).toBe('approval.resolved');
    expect(streamEventFor('expired')).toBe('approval.expired');
    expect(streamEventFor('cancelled')).toBe('approval.expired');
    expect(streamEventFor('abandoned')).toBe('approval.expired');
    expect(streamEventId(5, 'abc')).toBe('5:abc');
    expect(parseLastEventId('17:01900000-0000-7000-8000-00000000000a')).toEqual({ ms: 17, id: '01900000-0000-7000-8000-00000000000a' });
    expect(parseLastEventId('garbage')).toBeNull();
    expect(parseLastEventId(undefined)).toBeNull();
    expect(sseFrame('approval.created', '1:a', { x: 1 })).toBe('id: 1:a\nevent: approval.created\ndata: {"x":1}\n\n');
  });

  it('SSE stream over a real socket: keep-alives, scoped live events and Last-Event-ID replay', async () => {
    const app = await buildApp({
      config: ctx.s.config,
      logger: ctx.s.logger,
      dbs: ctx.s.dbs,
      auditStore: ctx.s.auditStore,
      clock: ctx.clock,
      version: 't',
      apiPlugins: [
        async (a) => {
          installWebAuth(a, { db: ctx.s.dbs.main.db, sessions: ctx.s.sessions });
          await approvalRoutes(a, ctx.s, { keepAliveMs: 40 });
        },
      ],
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const open = async (u: TestUser, lastEventId?: string) => {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/approvals/stream`, { headers: { cookie: u.cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }, signal: ac.signal });
      const reader = res.body!.getReader();
      let buf = '';
      const dec = new TextDecoder();
      const until = async (pred: (b: string) => boolean) => {
        const deadline = Date.now() + 5000;
        while (!pred(buf)) {
          if (Date.now() > deadline) throw new Error(`timed out; got: ${buf}`);
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
        }
        return buf;
      };
      return { res, until, text: () => buf, close: () => ac.abort() };
    };
    try {
      const ownerStream = await open(owner);
      const bobStream = await open(bob);
      if (ownerStream.res.headers.get('content-type') !== 'text/event-stream; charset=utf-8') throw new Error(`${ownerStream.res.status} ${await ownerStream.until((b) => b.length > 0)}`);
      expect(ownerStream.res.headers.get('cache-control')).toBe('no-cache, no-transform');
      await ownerStream.until((b) => b.includes(': keep-alive'));

      const { promise } = hold();
      const id = await pendingId();
      await ownerStream.until((b) => b.includes('event: approval.created'));
      const created = /id: (\S+)\nevent: approval\.created\ndata: (.+)\n/.exec(ownerStream.text())!;
      expect(JSON.parse(created[2]!)).toMatchObject({ id, status: 'pending', actions: ['approve', 'deny'] });
      await ctx.as(owner, { method: 'POST', url: `/api/approvals/${id}/approve`, payload: {} });
      await ownerStream.until((b) => b.includes('event: approval.resolved'));
      await promise;
      await bobStream.until((b) => b.includes(': keep-alive'));
      expect(bobStream.text()).not.toContain('event: approval');

      // reconnect with Last-Event-ID = the created event → replays only the resolution
      const replay = await open(owner, created[1]);
      await replay.until((b) => b.includes('event: approval.resolved'));
      expect(replay.text()).not.toContain('event: approval.created');
      for (const s of [ownerStream, bobStream, replay]) s.close();
      await wait(20);
      expect(ctx.s.approvalStream.size).toBe(0);
    } finally {
      await app.close();
    }
  });
});
