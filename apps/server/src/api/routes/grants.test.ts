import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeUpstream } from '../../../test-utils/fake-upstream.js';
import { createTestContext, type TestContext, type TestUser } from '../../test/fakes/context.js';

describe('grants REST', () => {
  let ctx: TestContext;
  let up: FakeUpstream;
  let admin: TestUser;
  let owner: TestUser;
  let other: TestUser;
  let alice: TestUser;
  let auditor: TestUser;
  let s1: string;
  let s2: string;
  let toolId: string;
  beforeEach(async () => {
    up = new FakeUpstream();
    ctx = await createTestContext({ upstreamFetch: () => up.fetch });
    admin = await ctx.user('admin@x.test', ['admin']);
    owner = await ctx.user('owner@x.test');
    other = await ctx.user('other@x.test');
    alice = await ctx.user('alice@x.test');
    auditor = await ctx.user('aud@x.test', ['auditor']);
    const mk = async (slug: string, ownerId: string) => (await ctx.as(admin, { method: 'POST', url: '/api/servers', payload: { name: slug, slug, ownerId, url: 'http://upstream.test/mcp', transport: 'streamable_http', auth: { type: 'none' }, autoApproveNewTools: true } })).json().id as string;
    s1 = await mk('one', owner.id);
    s2 = await mk('two', other.id);
    await ctx.s.jobs.idle();
    owner = await ctx.user('owner@x.test');
    other = await ctx.user('other@x.test');
    toolId = (await ctx.as(owner, { method: 'GET', url: '/api/tools' })).json().items[0].id;
  });
  afterEach(async () => {
    await ctx.close();
    await up.close();
  });

  it('owners manage grants on their servers only; duplicates 409', async () => {
    const g = await ctx.as(owner, { method: 'POST', url: '/api/grants', payload: { subject: { type: 'user', id: alice.id }, target: { type: 'server', id: s1 }, effect: 'allow' } });
    expect(g.statusCode).toBe(201);
    expect(g.json()).toMatchObject({ subject: { type: 'user', name: 'alice' }, target: { type: 'server', name: 'one', server: { id: s1 } }, effect: 'allow', source: 'manual', createdBy: { id: owner.id } });
    expect((await ctx.as(owner, { method: 'POST', url: '/api/grants', payload: { subject: { type: 'user', id: alice.id }, target: { type: 'server', id: s1 }, effect: 'allow' } })).statusCode).toBe(409);
    expect((await ctx.as(owner, { method: 'POST', url: '/api/grants', payload: { subject: { type: 'user', id: alice.id }, target: { type: 'server', id: s2 }, effect: 'allow' } })).statusCode).toBe(403);
    expect((await ctx.as(alice, { method: 'POST', url: '/api/grants', payload: { subject: { type: 'user', id: alice.id }, target: { type: 'server', id: s1 }, effect: 'allow' } })).statusCode).toBe(403);
    expect((await ctx.as(owner, { method: 'POST', url: '/api/grants', payload: { subject: { type: 'user', id: '01900000-0000-7000-8000-000000000000' }, target: { type: 'server', id: s1 }, effect: 'allow' } })).statusCode).toBe(422);
    // lists are scoped
    expect((await ctx.as(other, { method: 'GET', url: '/api/grants' })).json().items).toHaveLength(0);
    expect((await ctx.as(auditor, { method: 'GET', url: '/api/grants' })).json().items).toHaveLength(1);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/grants' })).json().items).toHaveLength(1);
    expect((await ctx.as(owner, { method: 'GET', url: `/api/grants?serverId=${s1}&effect=allow` })).json().items).toHaveLength(1);
    expect((await ctx.as(other, { method: 'DELETE', url: `/api/grants/${g.json().id}` })).statusCode).toBe(403);
    expect((await ctx.as(owner, { method: 'DELETE', url: `/api/grants/${g.json().id}` })).statusCode).toBe(204);
  });

  it('batch is all-or-nothing and lists offending entries', async () => {
    const bad = await ctx.as(owner, {
      method: 'POST',
      url: '/api/grants/batch',
      payload: { upserts: [{ subject: { type: 'user', id: alice.id }, target: { type: 'server', id: s1 }, effect: 'allow' }, { subject: { type: 'user', id: alice.id }, target: { type: 'server', id: s2 }, effect: 'allow' }], deletes: [] },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors).toMatchObject([{ path: ['upserts', '1', 'target'], code: 'forbidden' }]);
    expect((await ctx.as(auditor, { method: 'GET', url: '/api/grants' })).json().items).toHaveLength(0);
    const ok = await ctx.as(owner, {
      method: 'POST',
      url: '/api/grants/batch',
      payload: { upserts: [{ subject: { type: 'user', id: alice.id }, target: { type: 'server', id: s1 }, effect: 'allow' }, { subject: { type: 'user', id: alice.id }, target: { type: 'tool', id: toolId }, effect: 'deny' }], deletes: [] },
    });
    expect(ok.json()).toEqual({ created: 2, updated: 0, deleted: 0 });
    const again = await ctx.as(owner, { method: 'POST', url: '/api/grants/batch', payload: { upserts: [{ subject: { type: 'user', id: alice.id }, target: { type: 'server', id: s1 }, effect: 'allow', expiresAt: '2999-01-01T00:00:00Z' }], deletes: [] } });
    expect(again.json()).toEqual({ created: 0, updated: 1, deleted: 0 });
  });

  it('batch audits one admin event per affected server (owners see their server\'s changes)', async () => {
    const r = await ctx.as(admin, {
      method: 'POST',
      url: '/api/grants/batch',
      payload: { upserts: [{ subject: { type: 'user', id: alice.id }, target: { type: 'server', id: s1 }, effect: 'allow' }, { subject: { type: 'user', id: alice.id }, target: { type: 'server', id: s2 }, effect: 'allow' }], deletes: [] },
    });
    expect(r.json()).toEqual({ created: 2, updated: 0, deleted: 0 });
    await ctx.s.auditStore.flush();
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const events = (await ctx.as(admin, { method: 'GET', url: `/api/audit/events?from=${from}&to=${to}&kind=admin` })).json().items as { adminAction: string | null; server: { id: string } | null }[];
    const batch = events.filter((e) => e.adminAction === 'grant.batch');
    expect(batch.map((e) => e.server?.id).sort()).toEqual([s1, s2].sort());
    // the owner of server one sees only the event for their server
    const mine = (await ctx.as(owner, { method: 'GET', url: `/api/audit/events?from=${from}&to=${to}&kind=admin` })).json().items as { adminAction: string | null; server: { id: string } | null }[];
    expect(mine.filter((e) => e.adminAction === 'grant.batch').map((e) => e.server?.id)).toEqual([s1]);
  });

  it('effective access explains decisions with via; users only see themselves', async () => {
    await ctx.as(owner, { method: 'POST', url: '/api/grants', payload: { subject: { type: 'user', id: alice.id }, target: { type: 'server', id: s1 }, effect: 'allow' } });
    const eff = (await ctx.as(owner, { method: 'GET', url: `/api/grants/effective?subjectType=user&subjectId=${alice.id}&serverId=${s1}` })).json();
    expect(eff).toMatchObject({ decision: 'allow', perTool: [{ toolId, decision: 'allow', via: [{ kind: 'server', subject: { id: alice.id } }] }] });
    expect(eff.reasons).toHaveLength(1);
    expect((await ctx.as(owner, { method: 'GET', url: `/api/grants/effective?subjectType=user&subjectId=${alice.id}&serverId=${s2}` })).statusCode).toBe(403);
    expect((await ctx.as(alice, { method: 'GET', url: `/api/grants/effective?subjectType=user&subjectId=${alice.id}` })).json().decision).toBe('allow');
    expect((await ctx.as(alice, { method: 'GET', url: `/api/grants/effective?subjectType=user&subjectId=${owner.id}` })).statusCode).toBe(403);
    const agent = (await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'b' } })).json();
    const ag = (await ctx.as(alice, { method: 'GET', url: `/api/grants/effective?subjectType=agent&subjectId=${agent.id}&toolId=${toolId}` })).json();
    expect(ag).toMatchObject({ decision: 'allow', perTool: [{ inherited: true, via: [{ kind: 'owner' }] }] });
  });
});
