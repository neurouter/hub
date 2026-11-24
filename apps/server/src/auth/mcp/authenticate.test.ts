import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hmacSha256 } from '../../lib/crypto.js';
import { newId } from '../../lib/ids.js';
import { createTestContext, FakeClock, type TestContext } from '../../test/fakes/context.js';
import { bearerChallenge } from './challenge.js';
import { sameResource } from './authenticate.js';

describe('MCP authenticator', () => {
  let ctx: TestContext;
  const clock = new FakeClock();
  let key: string;
  let agentId: string;
  let userId: string;
  beforeEach(async () => {
    ctx = await createTestContext({ clock });
    const u = await ctx.user('a@x.test');
    userId = u.id;
    agentId = (await ctx.as(u, { method: 'POST', url: '/api/agents', payload: { name: 'bot' } })).json().id;
    key = (await ctx.as(u, { method: 'POST', url: `/api/agents/${agentId}/keys`, payload: { name: 'k', expiresAt: new Date(clock.now() + 3_600_000).toISOString() } })).json().secret;
  });
  afterEach(() => ctx.close());
  const auth = (h?: string) => ctx.s.authenticator.authenticate(h);

  it('accepts a valid API key and loads the principal', async () => {
    const r = await auth(`Bearer ${key}`);
    expect(r).toMatchObject({ ok: true, principal: { user: { id: userId }, agent: { id: agentId, narrowed: false }, authMethod: 'api_key', scopes: ['mcp:tools'] } });
  });

  it.each([undefined, 'Basic abc', 'Bearer', 'Bearer random'])('rejects %s', async (h) => {
    expect((await auth(h)).ok).toBe(false);
  });

  it('rejects a wrong secret for a known key id (constant-time compare)', async () => {
    const forged = key.slice(0, -1) + (key.endsWith('a') ? 'b' : 'a');
    expect(await auth(`Bearer ${forged}`)).toMatchObject({ ok: false, error: 'invalid_token' });
  });

  it('rejects expired keys, disabled agents and disabled owners', async () => {
    clock.advance(3_600_001);
    expect(await auth(`Bearer ${key}`)).toMatchObject({ ok: false, reason: 'api key expired' });
    clock.advance(-3_600_001);
    ctx.s.authenticator.clearCache();
    await ctx.s.dbs.main.db.updateTable('agents').set({ status: 'disabled' }).execute();
    expect(await auth(`Bearer ${key}`)).toMatchObject({ ok: false, reason: 'agent inactive' });
    ctx.s.authenticator.clearCache();
    await ctx.s.dbs.main.db.updateTable('agents').set({ status: 'active' }).execute();
    await ctx.s.dbs.main.db.updateTable('users').set({ status: 'disabled' }).execute();
    expect(await auth(`Bearer ${key}`)).toMatchObject({ ok: false, reason: 'owner disabled' });
  });

  it('validates OAuth access tokens: audience, scope, expiry, revocation', async () => {
    const db = ctx.s.dbs.main.db;
    const clientId = newId();
    await db.insertInto('oauth_clients').values({ id: clientId, client_id: 'https://app.test/cimd.json', registration_type: 'cimd', client_name: 'App', client_uri: null, logo_uri: null, token_endpoint_auth_method: 'none', client_secret_hash: null, application_type: null, metadata_fetched_at: null, metadata_expires_at: null, created_at: 1, updated_at: 1 }).execute();
    const mk = async (token: string, over: Record<string, unknown> = {}) =>
      db.insertInto('oauth_tokens').values({ id: newId(), token_hash: hmacSha256(ctx.s.config.hashPepper, token), kind: 'access', client_id: clientId, user_id: userId, agent_id: agentId, scopes: 'mcp:tools', resource: 'http://gw.test/mcp', family_id: newId(), parent_id: null, expires_at: clock.now() + 60_000, revoked_at: null, last_used_at: null, created_at: clock.now(), ...over }).execute();
    await mk('nr_at_good');
    await mk('nr_at_other_aud', { resource: 'https://other.test/mcp' });
    await mk('nr_at_noscope', { scopes: 'profile' });
    await mk('nr_at_expired', { expires_at: clock.now() - 1 });
    await mk('nr_at_upper', { resource: 'http://GW.test/mcp' });
    expect(await auth('Bearer nr_at_good')).toMatchObject({ ok: true, principal: { authMethod: 'oauth', oauthClientId: null } });
    expect(await auth('Bearer nr_at_upper')).toMatchObject({ ok: true });
    expect(await auth('Bearer nr_at_other_aud')).toMatchObject({ ok: false, error: 'invalid_token', reason: 'token audience mismatch' });
    expect(await auth('Bearer nr_at_noscope')).toMatchObject({ ok: false, error: 'insufficient_scope' });
    expect(await auth('Bearer nr_at_expired')).toMatchObject({ ok: false, error: 'invalid_token' });
    expect(await auth('Bearer nr_at_unknown')).toMatchObject({ ok: false });
  });

  it('builds the exact challenge header', () => {
    expect(bearerChallenge('https://mcp.acme', 'insufficient_scope')).toBe('Bearer resource_metadata="https://mcp.acme/.well-known/oauth-protected-resource/mcp", scope="mcp:tools", error="insufficient_scope"');
    expect(sameResource('https://A.test/mcp', 'https://a.test/mcp/')).toBe(true);
    expect(sameResource('https://a.test/mcp', 'https://a.test/other')).toBe(false);
  });

  it('updates last_used at most once a minute', async () => {
    await auth(`Bearer ${key}`);
    await new Promise((r) => setTimeout(r, 10));
    const k = await ctx.s.dbs.main.db.selectFrom('api_keys').select('last_used_at').executeTakeFirstOrThrow();
    expect(k.last_used_at).toBe(clock.now());
  });
});
