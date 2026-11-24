import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../test/fakes/context.js';
import { hashSecret, parseApiKey } from '../../identity/api-key-format.js';

describe('identity REST', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let auditor: TestUser;
  let alice: TestUser;
  beforeEach(async () => {
    ctx = await createTestContext();
    admin = await ctx.user('admin@x.test', ['admin']);
    auditor = await ctx.user('aud@x.test', ['auditor']);
    alice = await ctx.user('alice@x.test');
  });
  afterEach(() => ctx.close());

  it('me: 401 without session, full identity with one', async () => {
    const anon = await ctx.as(null, { method: 'GET', url: '/api/me' });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers['content-type']).toContain('application/problem+json');
    const me = (await ctx.as(admin, { method: 'GET', url: '/api/me' })).json();
    expect(me).toMatchObject({ user: { email: 'admin@x.test' }, roles: ['admin'], csrfToken: admin.csrf, ownedServerIds: [] });
    expect(me.capabilities).toContain('servers:create');
  });

  it('requires a CSRF token on mutations', async () => {
    const res = await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'a' }, headers: { 'x-csrf-token': 'nope' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe('csrf');
  });

  it('preferences round-trip', async () => {
    const res = await ctx.as(alice, { method: 'PATCH', url: '/api/me/preferences', payload: { theme: 'dark' } });
    expect(res.json()).toEqual({ preferences: { theme: 'dark' } });
    expect((await ctx.as(alice, { method: 'GET', url: '/api/me' })).json().preferences).toEqual({ theme: 'dark' });
    expect((await ctx.as(alice, { method: 'GET', url: '/api/me/badges' })).json()).toEqual({ pendingApprovals: 0, pendingAccessRequests: 0, toolsPendingReview: 0, myPendingRequests: 0, brokenConnections: 0 });
  });

  it.each([
    ['GET', '/api/users', null, { admin: 200, auditor: 200, alice: 403 }],
    ['POST', '/api/users', { email: 'new@x.test' }, { admin: 200, auditor: 403, alice: 403 }],
    ['GET', '/api/groups', null, { admin: 200, auditor: 200, alice: 200 }],
    ['POST', '/api/groups', { name: 'g1' }, { admin: 200, auditor: 403, alice: 403 }],
    ['GET', '/api/settings/oidc', null, { admin: 200, auditor: 200, alice: 403 }],
    ['PATCH', '/api/settings/oidc', { roleMappings: [] }, { admin: 200, auditor: 403, alice: 403 }],
    ['GET', '/api/agents?owner=all', null, { admin: 200, auditor: 200, alice: 403 }],
    ['GET', '/api/portal/client-config', null, { admin: 200, auditor: 200, alice: 200 }],
  ] as const)('guard matrix %s %s', async (method, url, payload, expected) => {
    for (const [who, u] of [['admin', admin], ['auditor', auditor], ['alice', alice]] as const) {
      const res = await ctx.as(u, { method, url, ...(payload ? { payload } : {}) });
      expect([who, res.statusCode]).toEqual([who, expected[who]]);
    }
    expect((await ctx.as(null, { method, url, ...(payload ? { payload } : {}) })).statusCode).toBe(401);
  });

  it('users: list, filter, paginate, detail, disable kills sessions', async () => {
    const page1 = (await ctx.as(admin, { method: 'GET', url: '/api/users?limit=2&sort=email' })).json();
    expect(page1.items.map((u: { email: string }) => u.email)).toEqual(['admin@x.test', 'alice@x.test']);
    const page2 = (await ctx.as(admin, { method: 'GET', url: `/api/users?limit=2&sort=email&cursor=${page1.nextCursor}` })).json();
    expect(page2.items.map((u: { email: string }) => u.email)).toEqual(['aud@x.test']);
    expect(page2.nextCursor).toBeNull();
    const auditors = (await ctx.as(admin, { method: 'GET', url: '/api/users?role=auditor' })).json();
    expect(auditors.items).toHaveLength(1);
    expect((await ctx.as(admin, { method: 'GET', url: '/api/users?cursor=garbage' })).statusCode).toBe(422);
    expect((await ctx.as(admin, { method: 'GET', url: '/api/users/not-a-uuid' })).statusCode).toBe(404);

    const d = (await ctx.as(admin, { method: 'PATCH', url: `/api/users/${alice.id}`, payload: { roles: ['auditor'], status: 'disabled' } })).json();
    expect(d).toMatchObject({ roles: ['auditor'], status: 'disabled', actions: ['update_roles', 'enable'] });
    expect((await ctx.as(alice, { method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await ctx.as(admin, { method: 'PATCH', url: `/api/users/${admin.id}`, payload: { status: 'disabled' } })).statusCode).toBe(409);
    expect((await ctx.as(admin, { method: 'POST', url: '/api/users', payload: { email: 'alice@x.test' } })).statusCode).toBe(409);
  });

  it('groups: CRUD, members, OIDC membership 409, claim mappings, Ref-only list for users', async () => {
    const g = (await ctx.as(admin, { method: 'POST', url: '/api/groups', payload: { name: 'Eng', description: 'd' } })).json();
    expect(g).toMatchObject({ name: 'Eng', source: 'local', memberCount: 0 });
    expect((await ctx.as(admin, { method: 'POST', url: '/api/groups', payload: { name: 'eng' } })).statusCode).toBe(409);
    expect((await ctx.as(admin, { method: 'POST', url: `/api/groups/${g.id}/members`, payload: { userIds: [alice.id, alice.id] } })).json()).toEqual({ added: 1 });
    const members = (await ctx.as(auditor, { method: 'GET', url: `/api/groups/${g.id}/members` })).json();
    expect(members.items).toMatchObject([{ user: { email: 'alice@x.test' }, source: 'local' }]);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/groups' })).json().items).toEqual([{ id: g.id, name: 'Eng' }]);
    expect((await ctx.as(auditor, { method: 'GET', url: '/api/groups' })).json().items[0]).toMatchObject({ memberCount: 1 });

    await ctx.s.dbs.main.db.updateTable('group_memberships').set({ source: 'oidc' }).execute();
    expect((await ctx.as(admin, { method: 'DELETE', url: `/api/groups/${g.id}/members/${alice.id}` })).statusCode).toBe(409);

    const m = (await ctx.as(admin, { method: 'POST', url: `/api/groups/${g.id}/claim-mappings`, payload: { claim: 'groups', value: 'eng' } })).json();
    expect((await ctx.as(admin, { method: 'POST', url: `/api/groups/${g.id}/claim-mappings`, payload: { claim: 'groups', value: 'eng' } })).statusCode).toBe(409);
    expect((await ctx.as(auditor, { method: 'GET', url: `/api/groups/${g.id}/claim-mappings` })).json().items).toEqual([{ id: m.id, claim: 'groups', value: 'eng', lastSeenAt: null }]);
    expect((await ctx.as(admin, { method: 'DELETE', url: `/api/groups/${g.id}/claim-mappings/${m.id}` })).statusCode).toBe(204);
    expect((await ctx.as(admin, { method: 'PATCH', url: `/api/groups/${g.id}`, payload: { name: 'Engineering' } })).json().name).toBe('Engineering');
    expect((await ctx.as(auditor, { method: 'GET', url: `/api/groups/${g.id}` })).json().actions).toEqual([]);
    expect((await ctx.as(admin, { method: 'DELETE', url: `/api/groups/${g.id}` })).statusCode).toBe(204);
    expect((await ctx.as(admin, { method: 'GET', url: `/api/groups/${g.id}` })).statusCode).toBe(404);
  });

  it('agents + API keys: secret once, HMAC at rest, revoke, ownership', async () => {
    const a = (await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'bot', description: 'my bot' } })).json();
    expect(a).toMatchObject({ name: 'bot', kind: 'api', status: 'active', activeKeyCount: 0, owner: { id: alice.id } });
    expect((await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'bot' } })).statusCode).toBe(409);
    expect((await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'x', exposureMode: 'list' } })).statusCode).toBe(422);

    const created = (await ctx.as(alice, { method: 'POST', url: `/api/agents/${a.id}/keys`, payload: { name: 'ci', expiresAt: null } })).json();
    expect(created.secret).toMatch(/^nr_live_[0-9A-Z]{10}_[0-9A-Za-z]{43}$/);
    expect(created.key).toMatchObject({ name: 'ci', status: 'active', prefix: created.secret.slice(0, 18) });
    const row = await ctx.s.dbs.main.db.selectFrom('api_keys').selectAll().executeTakeFirstOrThrow();
    const parsed = parseApiKey(created.secret)!;
    expect(row.secret_hash.equals(hashSecret(ctx.s.config.hashPepper, parsed.secret))).toBe(true);
    expect(JSON.stringify(row)).not.toContain(parsed.secret);
    const list = (await ctx.as(alice, { method: 'GET', url: `/api/agents/${a.id}/keys` })).json();
    expect(JSON.stringify(list)).not.toContain(parsed.secret);
    expect((await ctx.as(alice, { method: 'POST', url: `/api/agents/${a.id}/keys`, payload: { name: 'old', expiresAt: '2000-01-01T00:00:00Z' } })).statusCode).toBe(422);

    // others can't see it; auditors can read but not mutate
    const bob = await ctx.user('bob@x.test');
    expect((await ctx.as(bob, { method: 'GET', url: `/api/agents/${a.id}` })).statusCode).toBe(404);
    expect((await ctx.as(auditor, { method: 'GET', url: `/api/agents/${a.id}` })).json().actions).toEqual([]);
    expect((await ctx.as(auditor, { method: 'PATCH', url: `/api/agents/${a.id}`, payload: { name: 'z' } })).statusCode).toBe(403);
    expect((await ctx.as(alice, { method: 'GET', url: `/api/agents/${a.id}` })).json().activeKeyCount).toBe(1);

    const revoked = (await ctx.as(alice, { method: 'DELETE', url: `/api/agents/${a.id}/keys/${created.key.id}` })).json();
    expect(revoked.status).toBe('revoked');
    expect((await ctx.as(alice, { method: 'POST', url: `/api/agents/${a.id}/keys/revoke-all` })).statusCode).toBe(403);
    expect((await ctx.as(admin, { method: 'POST', url: `/api/agents/${a.id}/keys/revoke-all` })).json()).toEqual({ revoked: 0 });

    expect((await ctx.as(alice, { method: 'GET', url: '/api/agents' })).json().items).toHaveLength(1);
    expect((await ctx.as(alice, { method: 'DELETE', url: `/api/agents/${a.id}` })).statusCode).toBe(204);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/agents' })).json().items).toHaveLength(0);
    // name is free again
    expect((await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'bot' } })).statusCode).toBe(200);
  });

  it('agent scope: inherit by default, restricted ids must be within owner access', async () => {
    const a = (await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'bot' } })).json();
    expect((await ctx.as(alice, { method: 'GET', url: `/api/agents/${a.id}/scope` })).json()).toEqual({ mode: 'inherit', serverIds: [], toolIds: [] });
    const bad = await ctx.as(alice, { method: 'PUT', url: `/api/agents/${a.id}/scope`, payload: { mode: 'restricted', serverIds: ['01900000-0000-7000-8000-00000000abcd'], toolIds: [] } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].path).toEqual(['serverIds', '0']);
    const ok = (await ctx.as(alice, { method: 'PUT', url: `/api/agents/${a.id}/scope`, payload: { mode: 'restricted', serverIds: [], toolIds: [] } })).json();
    expect(ok.mode).toBe('restricted');
    expect((await ctx.as(alice, { method: 'GET', url: `/api/agents/${a.id}/access` })).json()).toEqual({ servers: [] });
  });

  it('OIDC role mappings: editable; connection fields are env-only (409)', async () => {
    const res = await ctx.as(admin, { method: 'PATCH', url: '/api/settings/oidc', payload: { roleMappings: [{ claim: 'groups', value: 'admins', role: 'admin' }, { claim: 'groups', value: 'admins', role: 'admin' }] } });
    expect(res.json()).toMatchObject({ roleMappings: [{ claim: 'groups', value: 'admins', role: 'admin' }], source: 'env', redirectUri: 'http://gw.test/api/auth/callback' });
    expect((await ctx.as(admin, { method: 'PATCH', url: '/api/settings/oidc', payload: { roleMappings: [], issuer: 'https://x' } })).statusCode).toBe(409);
  });

  it('gateway settings: grouped view, partial update, write-only webhook secret', async () => {
    const g = (await ctx.as(auditor, { method: 'GET', url: '/api/settings' })).json();
    expect(g).toMatchObject({ retention: { auditDays: 90, metricsDays: 400, storeFullOutput: false }, approvals: { timeoutMinutes: 5, maxTimeoutMinutes: 15 }, rateLimits: { agent: { perMinute: 600, burst: 120 } }, export: { hasWebhookSecret: false } });
    const u = await ctx.as(admin, { method: 'PATCH', url: '/api/settings', payload: { rateLimits: { agent: { perMinute: 60 } }, export: { webhookUrl: 'https://siem.example.com/hook', webhookSecret: 'x'.repeat(20), webhookEnabled: true } } });
    expect(u.json()).toMatchObject({ rateLimits: { agent: { perMinute: 60, burst: 120 } }, export: { webhookUrl: 'https://siem.example.com/hook', hasWebhookSecret: true, webhookEnabled: true } });
    expect(u.body).not.toContain('xxxxxxxxxxxxxxxxxxxx');
    expect((await ctx.s.settings.get('rateLimitDefaults')).agentPerMinute).toBe(60);
    expect((await ctx.as(admin, { method: 'PATCH', url: '/api/settings', payload: { approvals: { timeoutMinutes: 30, maxTimeoutMinutes: 10 } } })).statusCode).toBe(422);
    expect((await ctx.as(admin, { method: 'PATCH', url: '/api/settings', payload: { export: { webhookUrl: 'http://10.0.0.1/hook' } } })).statusCode).toBe(422);
    expect((await ctx.as(auditor, { method: 'PATCH', url: '/api/settings', payload: {} })).statusCode).toBe(403);
  });

  it('auth providers + dev login disabled outside development', async () => {
    expect((await ctx.as(null, { method: 'GET', url: '/api/auth/providers' })).json()).toEqual({ productName: 'Neurouter', providers: [] });
    expect((await ctx.as(null, { method: 'POST', url: '/api/auth/dev-login', payload: { email: 'a@b.test' } })).statusCode).toBe(404);
    const login = await ctx.as(null, { method: 'GET', url: '/api/auth/login' });
    expect(login.headers.location).toBe('/auth/login?error=idp_error');
  });
});
