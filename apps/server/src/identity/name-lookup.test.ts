import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalog } from '../test/fakes/catalog-builders.js';
import { createTestContext, type TestContext, type TestUser } from '../test/fakes/context.js';
import { MAX_LOOKUP_IDS } from './name-lookup.service.js';

describe('GET /api/lookup/names', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let auditor: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let gh: string;
  let tool: string;
  let aliceAgent: string;
  let bobAgent: string;
  let group: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    admin = await ctx.user('admin@x.test', ['admin']);
    auditor = await ctx.user('auditor@x.test', ['auditor']);
    alice = await ctx.user('alice@x.test');
    bob = await ctx.user('bob@x.test');
    const seeded = await seedCatalog(ctx.s.dbs.main.db, [{ slug: 'gh', tools: [{ name: 'create_issue', description: 'Create an issue' }] }]);
    gh = seeded.servers.gh!;
    tool = seeded.tools.gh__create_issue!;
    aliceAgent = (await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'alice-bot' } })).json().id;
    bobAgent = (await ctx.as(bob, { method: 'POST', url: '/api/agents', payload: { name: 'bob-bot' } })).json().id;
    group = (await ctx.as(admin, { method: 'POST', url: '/api/groups', payload: { name: 'sre' } })).json().id;
  });
  afterEach(async () => ctx.close());

  const lookup = async (who: TestUser, ids: string[]) => {
    const r = await ctx.as(who, { method: 'GET', url: `/api/lookup/names?${ids.map((i) => `ids=${encodeURIComponent(i)}`).join('&')}` });
    return { status: r.statusCode, body: r.json() };
  };

  it('admins and auditors resolve every kind', async () => {
    const all = [alice.id, group, aliceAgent, gh, tool];
    for (const who of [admin, auditor]) {
      const { status, body } = await lookup(who, all);
      expect(status).toBe(200);
      expect(body.names).toEqual({
        [alice.id]: { type: 'user', name: expect.any(String) },
        [group]: { type: 'group', name: 'sre' },
        [aliceAgent]: { type: 'agent', name: 'alice-bot' },
        [gh]: { type: 'server', name: expect.any(String) },
        [tool]: { type: 'tool', name: 'gh__create_issue' },
      });
    }
  });

  it('plain users only get what they could see elsewhere', async () => {
    const { body } = await lookup(alice, [alice.id, bob.id, group, aliceAgent, bobAgent, gh, tool, 'no-such-id']);
    expect(Object.keys(body.names).sort()).toEqual([alice.id, group, aliceAgent, gh, tool].sort());
    // with catalogVisibility=granted the un-granted server and its tools are hidden
    await ctx.s.settings.set('catalogVisibility', 'granted');
    const hidden = await lookup(alice, [gh, tool]);
    expect(hidden.body.names).toEqual({});
  });

  it('no ids → empty; more than the limit → 422', async () => {
    expect((await lookup(alice, [])).body).toEqual({ names: {} });
    const many = Array.from({ length: MAX_LOOKUP_IDS + 1 }, (_, i) => `id-${i}`);
    expect((await lookup(alice, many)).status).toBe(422);
  });
});
