import { EVERYONE_GROUP_ID } from '@neurouter/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, FakeClock, type TestContext } from '../../test/fakes/context.js';
import type { OidcProvider } from './oidc.js';

class FakeOidc implements OidcProvider {
  readonly issuer = 'https://idp.test';
  claims: Record<string, unknown> = {};
  lastAuth: { state: string; nonce: string; codeChallenge: string; redirectUri: string } | null = null;
  lastChecks: { codeVerifier: string; state: string; nonce: string } | null = null;
  async authorizationUrl(p: { redirectUri: string; scope: string; state: string; nonce: string; codeChallenge: string }) {
    this.lastAuth = p;
    return `https://idp.test/authorize?state=${p.state}`;
  }
  async callback(_url: URL, checks: { codeVerifier: string; state: string; nonce: string }) {
    this.lastChecks = checks;
    return { claims: this.claims, idToken: 'idtok' };
  }
  async endSessionUrl() {
    return 'https://idp.test/logout';
  }
}

describe('OIDC login', () => {
  let ctx: TestContext;
  let idp: FakeOidc;
  const clock = new FakeClock();
  beforeEach(async () => {
    idp = new FakeOidc();
    ctx = await createTestContext({ clock, oidcProvider: idp, env: { BOOTSTRAP_ADMIN_EMAIL: 'boss@acme.test', OIDC_ALLOWED_EMAIL_DOMAINS: 'acme.test', OIDC_GROUP_AUTO_CREATE: 'true' } });
  });
  afterEach(() => ctx.close());

  async function login(claims: Record<string, unknown>, returnTo = '/servers') {
    idp.claims = claims;
    const start = await ctx.app.inject({ method: 'GET', url: `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}` });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    return ctx.app.inject({ method: 'GET', url: `/api/auth/callback?code=c&state=${state}` });
  }

  it('wires state, nonce and PKCE, creates a session and redirects to returnTo', async () => {
    const res = await login({ sub: 's1', email: 'Ann@acme.test', email_verified: true, name: 'Ann' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/servers');
    expect(String(res.headers['set-cookie'])).toMatch(/nr_session=.*HttpOnly.*SameSite=Lax/i);
    expect(idp.lastChecks!.state).toBe(idp.lastAuth!.state);
    expect(idp.lastChecks!.nonce).toBe(idp.lastAuth!.nonce);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(idp.lastChecks!.codeVerifier).digest('base64url')).toBe(idp.lastAuth!.codeChallenge);
    const user = await ctx.s.dbs.main.db.selectFrom('users').selectAll().where('email', '=', 'ann@acme.test').executeTakeFirstOrThrow();
    expect(user).toMatchObject({ oidc_issuer: 'https://idp.test', oidc_subject: 's1', name: 'Ann' });
    // state is single use
    const replay = await ctx.app.inject({ method: 'GET', url: `/api/auth/callback?code=c&state=${idp.lastAuth!.state}` });
    expect(replay.headers.location).toBe('/auth/login?error=idp_error');
  });

  it('rejects an open-redirect returnTo', async () => {
    const res = await login({ sub: 's1', email: 'ann@acme.test' }, '//evil.test/x');
    expect(res.headers.location).toBe('/');
  });

  it.each([
    [{ sub: 's1', email: 'x@other.test' }, 'access_denied'],
    [{ sub: 's1', email: 'x@acme.test', email_verified: false }, 'access_denied'],
    [{ email: 'x@acme.test' }, 'access_denied'],
  ])('refuses %o', async (claims, code) => {
    const res = await login(claims);
    expect(res.headers.location).toBe(`/auth/login?error=${code}`);
  });

  it('expired state → idp_error', async () => {
    idp.claims = { sub: 's1', email: 'a@acme.test' };
    const start = await ctx.app.inject({ method: 'GET', url: '/api/auth/login' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    clock.advance(11 * 60_000);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/auth/callback?state=${state}` });
    expect(res.headers.location).toBe('/auth/login?error=idp_error');
  });

  it('disabled users are refused', async () => {
    await login({ sub: 's9', email: 'd@acme.test' });
    await ctx.s.dbs.main.db.updateTable('users').set({ status: 'disabled' }).where('email', '=', 'd@acme.test').execute();
    const res = await login({ sub: 's9', email: 'd@acme.test' });
    expect(res.headers.location).toBe('/auth/login?error=disabled');
  });

  it('links a pre-provisioned user by email and applies the bootstrap admin', async () => {
    // boss@acme.test was pre-created at boot because no admin existed
    const pre = await ctx.s.dbs.main.db.selectFrom('users').select('id').where('email', '=', 'boss@acme.test').executeTakeFirstOrThrow();
    await login({ sub: 'b1', email: 'boss@acme.test', email_verified: true });
    const u = await ctx.s.dbs.main.db.selectFrom('users').selectAll().where('email', '=', 'boss@acme.test').executeTakeFirstOrThrow();
    expect(u.id).toBe(pre.id);
    expect(u.oidc_subject).toBe('b1');
    const roles = await ctx.s.dbs.main.db.selectFrom('user_roles').selectAll().where('user_id', '=', u.id).execute();
    expect(roles).toMatchObject([{ role: 'admin', source: 'bootstrap' }]);
  });

  it('syncs OIDC groups (add/remove, local untouched) and role mappings', async () => {
    const db = ctx.s.dbs.main.db;
    await ctx.s.settings.set('oidcRoleMappings', [{ claim: 'groups', value: 'sec', role: 'auditor' }]);
    await login({ sub: 's1', email: 'ann@acme.test', groups: ['eng', 'sec'] });
    const u = await db.selectFrom('users').select('id').where('email', '=', 'ann@acme.test').executeTakeFirstOrThrow();
    const names = async () => (await db.selectFrom('group_memberships as m').innerJoin('groups as g', 'g.id', 'm.group_id').select(['g.name', 'm.source']).where('m.user_id', '=', u.id).orderBy('g.name').execute());
    expect(await names()).toEqual([{ name: 'eng', source: 'oidc' }, { name: 'sec', source: 'oidc' }]);
    expect(await db.selectFrom('groups').select(['name', 'source']).where('id', '!=', EVERYONE_GROUP_ID).orderBy('name').execute()).toEqual([{ name: 'eng', source: 'oidc' }, { name: 'sec', source: 'oidc' }]);
    expect((await db.selectFrom('user_roles').selectAll().where('user_id', '=', u.id).execute()).map((r) => [r.role, r.source])).toEqual([['auditor', 'oidc']]);

    // a local membership survives; the stale oidc membership and role go away
    const local = await db.insertInto('groups').values({ id: '01900000-0000-7000-8000-000000000001', name: 'local', description: '', source: 'local', created_at: 1, updated_at: 1 }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('group_memberships').values({ group_id: local.id, user_id: u.id, source: 'local', created_at: 1 }).execute();
    await login({ sub: 's1', email: 'ann@acme.test', groups: ['eng'] });
    expect(await names()).toEqual([{ name: 'eng', source: 'oidc' }, { name: 'local', source: 'local' }]);
    expect(await db.selectFrom('user_roles').selectAll().where('user_id', '=', u.id).execute()).toEqual([]);
  });

  it('logout destroys the session and returns the IdP end-session URL', async () => {
    const res = await login({ sub: 's1', email: 'ann@acme.test' });
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const me = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const csrf = me.json().csrfToken as string;
    const out = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-csrf-token': csrf } });
    expect(out.json()).toEqual({ redirectTo: 'https://idp.test/logout' });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('sessions', () => {
  it('expire on idle and absolute TTL, and slide last_seen_at', async () => {
    const clock = new FakeClock();
    const ctx = await createTestContext({ clock, env: { SESSION_IDLE_MINUTES: '30', SESSION_TTL_HOURS: '1' } });
    try {
      const u = await ctx.user('a@x.test');
      const me = () => ctx.as(u, { method: 'GET', url: '/api/me' });
      clock.advance(29 * 60_000);
      expect((await me()).statusCode).toBe(200); // slides
      clock.advance(29 * 60_000);
      expect((await me()).statusCode).toBe(200);
      clock.advance(3 * 60_000); // > 1 h absolute
      expect((await me()).statusCode).toBe(401);
      const v = await ctx.user('b@x.test');
      clock.advance(31 * 60_000);
      expect((await ctx.as(v, { method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    } finally {
      await ctx.close();
    }
  });
});
