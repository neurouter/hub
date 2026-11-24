import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { FakeUpstream } from '../../test-utils/fake-upstream.js';
import { s256 } from '../oauth/pkce.js';
import { createTestContext, type TestContext, type TestUser } from '../test/fakes/context.js';
import { injectFetch } from '../test/fakes/inject-fetch.js';

const GW = 'https://gw.test';
const AS = 'https://as.test';
const UP = 'https://up.test/mcp';

/** A fake upstream authorization server (RFC 8414 + RFC 9728 PRM on the MCP server). */
class FakeAs {
  codes = new Map<string, { challenge: string; resource: string; label: string }>();
  issued: Array<{ grant: string; body: Record<string, string> }> = [];
  revoked: string[] = [];
  refreshFails = false;
  issuer = AS;
  next = 0;
  meta() {
    return { issuer: this.issuer, authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, revocation_endpoint: `${AS}/revoke`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true, scopes_supported: ['repo'] };
  }
  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return u.host === 'up.test' ? Response.json({ resource: UP, authorization_servers: [AS] }) : new Response('', { status: 404 });
    if (u.host === 'as.test' && u.pathname === '/.well-known/oauth-authorization-server') return Response.json(this.meta());
    if (u.host === 'as.test' && u.pathname === '/token') {
      const body = Object.fromEntries(new URLSearchParams(await req.text()));
      this.issued.push({ grant: body.grant_type!, body });
      if (body.grant_type === 'authorization_code') {
        const c = this.codes.get(body.code!);
        if (!c || s256(body.code_verifier!) !== c.challenge || body.resource !== c.resource) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        this.codes.delete(body.code!);
        return Response.json({ access_token: `at-${c.label}-${++this.next}`, refresh_token: `rt-${c.label}`, token_type: 'Bearer', expires_in: 3600, scope: 'repo' });
      }
      if (body.grant_type === 'refresh_token') {
        if (this.refreshFails) return Response.json({ error: 'invalid_grant', error_description: 'revoked' }, { status: 400 });
        const label = body.refresh_token!.slice(3);
        return Response.json({ access_token: `at-${label}-${++this.next}`, token_type: 'Bearer', expires_in: 3600 });
      }
    }
    if (u.host === 'as.test' && u.pathname === '/revoke') {
      this.revoked.push(new URLSearchParams(await req.text()).get('token')!);
      return new Response('', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }
}

describe('per-user upstream OAuth', () => {
  let ctx: TestContext;
  let up: FakeUpstream;
  let as: FakeAs;
  let admin: TestUser;
  let owner: TestUser;
  let alice: TestUser;
  let serverId: string;

  beforeEach(async () => {
    as = new FakeAs();
    up = new FakeUpstream({ tools: [{ name: 'whoami', description: 'Who am I upstream', inputSchema: { type: 'object' } }] });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return new URL(req.url).pathname === '/mcp' ? up.fetch(req) : as.handle(req);
    };
    ctx = await createTestContext({ env: { PUBLIC_URL: GW, ORG_NAME: 'Acme' }, upstreamFetch: () => fetch });
    admin = await ctx.user('admin@x.test', ['admin']);
    owner = await ctx.user('owner@x.test');
    alice = await ctx.user('alice@x.test');
    const created = await ctx.as(admin, { method: 'POST', url: '/api/servers', payload: { name: 'Repo', slug: 'repo', ownerId: owner.id, url: UP, transport: 'streamable_http', auth: { type: 'per_user_oauth', oauth: { discovery: 'auto', scopes: ['repo'] } }, autoApproveNewTools: true } });
    expect(created.statusCode, created.body).toBe(201);
    serverId = created.json().id;
    await ctx.s.jobs.idle();
  });
  afterEach(async () => {
    await ctx.close();
    await up.close();
  });

  /** Browser: start → upstream AS (simulated) → gateway callback. Returns the final SPA location. */
  async function connect(user: TestUser, label: string, opts: { iss?: string | null; tamperState?: boolean; asUser?: TestUser } = {}) {
    const start = await ctx.as(user, { method: 'GET', url: `/api/me/connections/${serverId}/authorize?returnTo=/connections` });
    expect(start.statusCode, start.body).toBe(302);
    const authUrl = new URL(start.headers.location as string);
    if (authUrl.origin !== AS) return { start: start.headers.location as string };
    expect(authUrl.pathname).toBe('/authorize');
    expect(authUrl.searchParams.get('client_id')).toBe(`${GW}/oauth/client-metadata.json`);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(`${GW}/oauth/upstream/callback`);
    expect(authUrl.searchParams.get('resource')).toBe(UP);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('scope')).toBe('repo');
    const code = `code-${label}`;
    as.codes.set(code, { challenge: authUrl.searchParams.get('code_challenge')!, resource: authUrl.searchParams.get('resource')!, label });
    const state = opts.tamperState ? 'forged' : authUrl.searchParams.get('state')!;
    const q = new URLSearchParams({ code, state, ...(opts.iss === null ? {} : { iss: opts.iss ?? AS }) });
    const cb = await ctx.app.inject({ method: 'GET', url: `/oauth/upstream/callback?${q}`, headers: { cookie: (opts.asUser ?? user).cookie } });
    expect(cb.statusCode).toBe(302);
    return { location: cb.headers.location as string, authUrl };
  }

  it('serves the gateway CIMD document', async () => {
    const doc = (await ctx.app.inject({ method: 'GET', url: '/oauth/client-metadata.json' })).json();
    expect(doc).toEqual({ client_id: `${GW}/oauth/client-metadata.json`, client_name: 'Neurouter (Acme)', client_uri: GW, redirect_uris: [`${GW}/oauth/upstream/callback`], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  });

  it('owner connects (sync user), users connect, and calls run with each user\'s own upstream token', async () => {
    // nobody connected yet: alice has no access anyway
    const denied = await ctx.as(alice, { method: 'GET', url: `/api/me/connections/${serverId}/authorize` });
    expect(denied.headers.location).toBe(`/connections?error=forbidden&server=${serverId}`);

    const r = await connect(owner, 'owner');
    expect(r.location).toBe(`/connections?connected=${serverId}`);
    await ctx.s.jobs.idle();
    await new Promise((res) => setTimeout(res, 50)); // initial sync kicked after the first connection
    const tools = (await ctx.as(owner, { method: 'GET', url: '/api/tools' })).json().items as { id: string; name: string }[];
    expect(tools.map((t) => t.name)).toEqual(['whoami']);
    // tokens are encrypted at rest
    const row = await ctx.s.dbs.main.db.selectFrom('user_upstream_tokens').selectAll().where('user_id', '=', owner.id).executeTakeFirstOrThrow();
    expect(row.access_ct.toString('utf8')).not.toContain('at-owner');
    expect(row).toMatchObject({ issuer: AS, status: 'active', scopes: 'repo' });

    await ctx.as(owner, { method: 'POST', url: '/api/grants', payload: { subject: { type: 'user', id: alice.id }, target: { type: 'server', id: serverId }, effect: 'allow' } });
    const agent = (await ctx.as(alice, { method: 'POST', url: '/api/agents', payload: { name: 'bot' } })).json();
    const key = (await ctx.as(alice, { method: 'POST', url: `/api/agents/${agent.id}/keys`, payload: { name: 'k', expiresAt: null } })).json().secret;
    const c = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${GW}/mcp`), { fetch: injectFetch(ctx.app), requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    const before = await c.callTool({ name: 'call_tool', arguments: { name: 'repo__whoami', arguments: {} } });
    expect(before).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(`Connect your Repo account at ${GW}/connections`) }] });

    const list = (await ctx.as(alice, { method: 'GET', url: '/api/me/connections' })).json().items;
    expect(list).toEqual([expect.objectContaining({ server: { id: serverId, name: 'Repo' }, status: 'not_connected' })]);
    expect((await connect(alice, 'alice')).location).toBe(`/connections?connected=${serverId}`);
    const after = await c.callTool({ name: 'call_tool', arguments: { name: 'repo__whoami', arguments: {} } });
    expect(after.isError).toBeFalsy();
    expect(up.calls.at(-1)!.headers.get('authorization')).toMatch(/^Bearer at-alice-\d$/);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/me/connections' })).json().items[0]).toMatchObject({ status: 'connected', scopes: ['repo'] });
    await c.close();
  });

  it('refreshes near expiry (on use and by job) and marks invalid_grant as refresh_failed', async () => {
    await connect(owner, 'owner');
    const db = ctx.s.dbs.main.db;
    await db.updateTable('user_upstream_tokens').set({ expires_at: Date.now() + 30_000 }).where('user_id', '=', owner.id).execute();
    ctx.s.credentials.invalidate(serverId); // (cached headers are bounded by the token's own expiry in real time)
    // on use: the credential resolver refreshes when < 60 s are left
    const h = await ctx.s.credentials.headersFor({ id: serverId, authMode: 'user_oauth' }, owner.id);
    expect(h.authorization).toMatch(/^Bearer at-owner-2$/);
    expect(as.issued.at(-1)).toMatchObject({ grant: 'refresh_token', body: { refresh_token: 'rt-owner', resource: UP } });
    // the old refresh token is kept when the AS doesn't rotate
    await db.updateTable('user_upstream_tokens').set({ expires_at: Date.now() + 5 * 60_000, updated_at: 0 }).where('user_id', '=', owner.id).execute();
    await db.updateTable('users').set({ last_login_at: Date.now() }).where('id', '=', owner.id).execute();
    expect(await ctx.s.upstreamOAuth.refreshDue()).toEqual({ refreshed: 1, failed: 0, errors: 0 });
    as.refreshFails = true;
    await db.updateTable('user_upstream_tokens').set({ expires_at: Date.now() + 5 * 60_000 }).where('user_id', '=', owner.id).execute();
    expect(await ctx.s.upstreamOAuth.refreshDue()).toEqual({ refreshed: 0, failed: 1, errors: 0 });
    const items = (await ctx.as(owner, { method: 'GET', url: '/api/me/connections' })).json().items;
    expect(items[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/reconnect/) });
    await expect(ctx.s.credentials.headersFor({ id: serverId, authMode: 'user_oauth' }, owner.id)).rejects.toMatchObject({ kind: 'connect_required' });
    expect((await ctx.as(owner, { method: 'GET', url: '/api/me/badges' })).json().brokenConnections).toBe(1);
  });

  it('callback security: state is single-use and bound to the session user; iss must match (RFC 9207)', async () => {
    expect((await connect(owner, 'x', { tamperState: true })).location).toBe('/connections?error=invalid_state');
    expect((await connect(owner, 'y', { asUser: alice })).location).toBe(`/connections?error=session_mismatch&server=${serverId}`);
    expect((await connect(owner, 'z', { iss: 'https://evil.test' })).location).toBe(`/connections?error=issuer_mismatch&server=${serverId}`);
    expect((await connect(owner, 'w', { iss: null })).location).toMatch(/error=issuer_mismatch|error=invalid_request|error=token_exchange_failed/);
    expect(await ctx.s.dbs.main.db.selectFrom('user_upstream_tokens').select('id').execute()).toEqual([]);
    // AS reports an error back to the callback
    const start = await ctx.as(owner, { method: 'GET', url: `/api/me/connections/${serverId}/authorize` });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cb = await ctx.app.inject({ method: 'GET', url: `/oauth/upstream/callback?error=access_denied&state=${state}`, headers: { cookie: owner.cookie } });
    expect(cb.headers.location).toBe(`/connections?error=access_denied&server=${serverId}`);
    // replaying a used state fails
    const replay = await ctx.app.inject({ method: 'GET', url: `/oauth/upstream/callback?code=c&state=${state}`, headers: { cookie: owner.cookie } });
    expect(replay.headers.location).toBe('/connections?error=invalid_state');
    expect(as.issued).toEqual([]);
  });

  it('disconnect revokes at the upstream AS (best effort) and deletes the token', async () => {
    await connect(owner, 'owner');
    expect((await ctx.as(owner, { method: 'DELETE', url: `/api/me/connections/${serverId}` })).statusCode).toBe(204);
    expect(as.revoked).toEqual(['rt-owner']);
    expect(await ctx.s.dbs.main.db.selectFrom('user_upstream_tokens').select('id').execute()).toEqual([]);
    expect((await ctx.as(owner, { method: 'DELETE', url: `/api/me/connections/${serverId}` })).statusCode).toBe(404);
  });

  it('DEK rotation re-encrypts upstream tokens', async () => {
    await connect(owner, 'owner');
    const before = await ctx.s.dbs.main.db.selectFrom('user_upstream_tokens').select('dek_id').executeTakeFirstOrThrow();
    const job = await ctx.as(admin, { method: 'POST', url: '/api/system/keys/rotate', payload: { type: 'dek' } });
    expect(job.statusCode, job.body).toBe(202);
    await ctx.s.jobs.idle();
    const done = (await ctx.as(admin, { method: 'GET', url: `/api/jobs/${job.json().jobId}` })).json();
    expect(done).toMatchObject({ status: 'succeeded', result: { type: 'dek', reencrypted: expect.any(Number) } });
    const after = await ctx.s.dbs.main.db.selectFrom('user_upstream_tokens').select('dek_id').executeTakeFirstOrThrow();
    expect(after.dek_id).not.toBe(before.dek_id);
    expect((await ctx.s.credentials.headersFor({ id: serverId, authMode: 'user_oauth' }, owner.id)).authorization).toBe('Bearer at-owner-1');
  });
});
