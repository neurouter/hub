import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auth, Client, StreamableHTTPClientTransport, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { FakeUpstream } from '../../test-utils/fake-upstream.js';
import { createTestContext, type TestContext, type TestUser } from '../test/fakes/context.js';
import { injectFetch } from '../test/fakes/inject-fetch.js';
import { s256 } from './pkce.js';

const GW = 'https://gw.test';
const MCP = `${GW}/mcp`;
const CIMD_URL = 'https://client.example/mcp-client.json';
const REDIRECT = 'http://127.0.0.1:33418/callback';

/** In-memory OAuthClientProvider (what an MCP client like Claude Code implements). */
class MemoryProvider implements OAuthClientProvider {
  info: Record<string, unknown> | undefined;
  saved: { access_token: string; refresh_token?: string } | undefined;
  verifier = '';
  authUrl: URL | null = null;
  constructor(readonly clientMetadataUrl?: string) {}
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return { client_name: 'Test MCP Client', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  clientInformation() {
    return this.info as never;
  }
  saveClientInformation(i: unknown) {
    this.info = i as Record<string, unknown>;
  }
  tokens() {
    return this.saved as never;
  }
  saveTokens(t: unknown) {
    this.saved = t as MemoryProvider['saved'];
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

describe('gateway as OAuth 2.1 AS for MCP clients', () => {
  let ctx: TestContext;
  let up: FakeUpstream;
  let admin: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let serverId: string;
  let cimdResponses = 0;
  const clients: Client[] = [];

  beforeEach(async () => {
    cimdResponses = 0;
    up = new FakeUpstream({ tools: [{ name: 'echo', description: 'Echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
    ctx = await createTestContext({
      env: { PUBLIC_URL: GW },
      upstreamFetch: () => up.fetch,
      outboundFetch: async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === CIMD_URL) {
          cimdResponses++;
          return Response.json({ client_id: CIMD_URL, client_name: 'Example IDE', client_uri: 'https://client.example', logo_uri: 'https://client.example/logo.png', redirect_uris: [REDIRECT, 'https://client.example/cb'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
        }
        return new Response('not found', { status: 404 });
      },
    });
    admin = await ctx.user('admin@x.test', ['admin']);
    alice = await ctx.user('alice@x.test');
    bob = await ctx.user('bob@x.test');
    const created = await ctx.as(admin, { method: 'POST', url: '/api/servers', payload: { name: 'Util', slug: 'util', ownerId: admin.id, url: 'http://upstream.test/mcp', transport: 'streamable_http', auth: { type: 'none' }, autoApproveNewTools: true } });
    expect(created.statusCode, created.body).toBe(201);
    serverId = created.json().id;
    await ctx.s.jobs.idle();
    await ctx.as(admin, { method: 'POST', url: '/api/grants', payload: { subject: { type: 'user', id: alice.id }, target: { type: 'server', id: serverId }, effect: 'allow' } });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await ctx.close();
    await up.close();
  });

  const fetchFn = () => injectFetch(ctx.app);

  /** Plays the browser: authorize (signed in) → consent page → decision. Returns the client redirect. */
  async function browser(authUrl: URL, user: TestUser, decision: 'approve' | 'deny' = 'approve', body: Record<string, unknown> = {}) {
    const a = await ctx.app.inject({ method: 'GET', url: authUrl.pathname + authUrl.search, headers: { cookie: user.cookie } });
    expect(a.statusCode, a.body).toBe(302);
    const location = a.headers.location as string;
    expect(location).toMatch(/^\/auth\/consent\?request=[0-9a-f-]{36}$/);
    const requestId = location.split('=')[1]!;
    const setCookie = String(a.headers['set-cookie']);
    expect(setCookie).toMatch(/^__Host-nr_consent=[^;]+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Strict/);
    const consentCookie = setCookie.split(';')[0]!;
    expect(a.headers['cache-control']).toBe('no-store');
    const details = await ctx.as(user, { method: 'GET', url: `/api/oauth/consent/${requestId}` });
    expect(details.statusCode, details.body).toBe(200);
    const res = await ctx.app.inject({ method: 'POST', url: `/api/oauth/consent/${requestId}`, headers: { cookie: `${user.cookie}; ${consentCookie}`, 'x-csrf-token': user.csrf, 'content-type': 'application/json' }, payload: { decision, ...body } });
    expect(res.statusCode, res.body).toBe(200);
    return { requestId, consentCookie, consent: details.json(), redirect: new URL(res.json().redirectTo as string) };
  }

  it('an MCP client discovers the PRM, registers (DCR), completes login + consent, and calls tools; refresh rotates', async () => {
    const p = new MemoryProvider();
    expect(await auth(p, { serverUrl: MCP, fetchFn: fetchFn() })).toBe('REDIRECT');
    expect(p.info?.client_id).toMatch(/^nr_dcr_/);
    const authUrl = p.authUrl!;
    expect(authUrl.origin + authUrl.pathname).toBe(`${GW}/oauth/authorize`);
    expect(authUrl.searchParams.get('resource')).toBe(MCP);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');

    // not signed in → login first, resuming this exact request
    const anon = await ctx.app.inject({ method: 'GET', url: authUrl.pathname + authUrl.search });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toBe(`/auth/login?returnTo=${encodeURIComponent(authUrl.pathname + authUrl.search)}`);

    const { consent, redirect } = await browser(authUrl, alice, 'approve', { agentName: 'My IDE' });
    expect(consent).toMatchObject({ client: { name: 'Test MCP Client', registration: 'dcr', verified: false, idHost: null, logoUri: null }, redirectUri: REDIRECT, redirectHost: '127.0.0.1:33418', localhostOnly: true, scopes: [{ name: 'mcp:tools', description: expect.any(String) }], resource: MCP, user: { email: 'alice@x.test' }, agents: [] });
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    expect(redirect.searchParams.get('iss')).toBe(GW);
    expect(redirect.searchParams.get('state')).toBe(authUrl.searchParams.get('state'));
    const code = redirect.searchParams.get('code')!;
    expect(await auth(p, { serverUrl: MCP, authorizationCode: code, iss: GW, fetchFn: fetchFn() })).toBe('AUTHORIZED');
    expect(p.saved!.access_token).toMatch(/^nr_at_/);
    expect(p.saved!.refresh_token).toMatch(/^nr_rt_/);

    // the agent was auto-created for alice and bound to the client
    const agents = (await ctx.as(alice, { method: 'GET', url: '/api/agents' })).json().items as { name: string; kind: string }[];
    expect(agents).toEqual([expect.objectContaining({ name: 'My IDE', kind: 'oauth_client' })]);

    const c = new Client({ name: 'oauth-client', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: p, fetch: fetchFn() }));
    clients.push(c);
    const r = await c.callTool({ name: 'call_tool', arguments: { name: 'util__echo', arguments: { text: 'hi' } } });
    expect(r.isError).toBeFalsy();
    // the gateway token never reaches the upstream
    for (const req of up.requests) expect(JSON.stringify(req)).not.toContain(p.saved!.access_token);

    // refresh rotation; reusing the rotated token revokes the family
    const oldRefresh = p.saved!.refresh_token!;
    const tok = (body: Record<string, string>) => ctx.app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body).toString() });
    const rotated = await tok({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: p.info!.client_id as string, resource: MCP });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.headers['cache-control']).toBe('no-store');
    const fresh = rotated.json();
    expect(fresh.refresh_token).not.toBe(oldRefresh);
    const mcpWith = (t: string) => ctx.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect((await mcpWith(fresh.access_token)).statusCode).toBe(200);
    const reuse = await tok({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: p.info!.client_id as string });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await mcpWith(fresh.access_token)).statusCode).toBe(401);
    expect((await tok({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: p.info!.client_id as string })).json().error).toBe('invalid_grant');
  });

  it('CIMD client: verified consent, code single-use with family revoke on reuse, PKCE/redirect/resource checks', async () => {
    const verifier = 'v'.repeat(50);
    const authorize = (q: Record<string, string>) => new URL(`${GW}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CIMD_URL, redirect_uri: 'http://127.0.0.1:5555/callback', code_challenge: s256(verifier), code_challenge_method: 'S256', resource: MCP, state: 'xyz', ...q })}`);
    const { consent, redirect } = await browser(authorize({}), alice);
    expect(consent.client).toEqual({ id: CIMD_URL, idHost: 'client.example', name: 'Example IDE', logoUri: 'https://client.example/logo.png', clientUri: 'https://client.example', registration: 'cimd', verified: true });
    expect(consent.localhostOnly).toBe(false);
    const code = redirect.searchParams.get('code')!;
    expect(redirect.port).toBe('5555'); // loopback: any port
    const tok = (body: Record<string, string>) => ctx.app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body).toString() });
    const base = { grant_type: 'authorization_code', code, client_id: CIMD_URL, redirect_uri: 'http://127.0.0.1:5555/callback', code_verifier: verifier, resource: MCP };
    expect((await tok({ ...base, code: 'nope' })).json().error).toBe('invalid_grant');
    const good = await tok(base);
    expect(good.statusCode, good.body).toBe(200);
    expect(good.json()).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:tools' });
    // reuse → invalid_grant and everything issued from that code is revoked
    expect((await tok(base)).json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringMatching(/already used/) });
    const revoked = await ctx.s.authenticator.authenticate(`Bearer ${good.json().access_token}`);
    expect(revoked.ok).toBe(false);

    const second = await browser(authorize({}), alice);
    const code2 = second.redirect.searchParams.get('code')!;
    expect(second.consent.agents).toHaveLength(1); // the agent from the first consent can be reused
    expect((await tok({ ...base, code: code2, code_verifier: 'w'.repeat(50) })).json()).toMatchObject({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    const third = (await browser(authorize({}), alice, 'approve', { agentId: second.consent.agents[0].id })).redirect.searchParams.get('code')!;
    expect((await tok({ ...base, code: third, redirect_uri: 'http://127.0.0.1:5556/callback' })).json().error).toBe('invalid_grant');
    const fourth = (await browser(authorize({}), alice)).redirect.searchParams.get('code')!;
    expect((await tok({ ...base, code: fourth, resource: 'https://other.example/mcp' })).json().error).toBe('invalid_target');
    expect(cimdResponses).toBe(1); // document cached (5 min minimum)
  });

  it('refuses without redirecting: unknown client, non-matching redirect URI; other errors redirect with state + iss', async () => {
    const q = (over: Record<string, string>) => `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CIMD_URL, redirect_uri: REDIRECT, code_challenge: s256('v'.repeat(50)), code_challenge_method: 'S256', resource: MCP, state: 's1', ...over })}`;
    const wrongRedirect = await ctx.app.inject({ method: 'GET', url: q({ redirect_uri: 'https://evil.example/cb' }), headers: { cookie: alice.cookie } });
    expect(wrongRedirect.statusCode).toBe(400);
    expect(wrongRedirect.headers.location).toBeUndefined();
    expect(wrongRedirect.headers['content-type']).toMatch(/text\/html/);
    expect(wrongRedirect.body).toContain('is not registered');
    expect(wrongRedirect.headers['x-frame-options']).toBe('DENY');
    const unknown = await ctx.app.inject({ method: 'GET', url: q({ client_id: 'nr_dcr_unknown' }) });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.headers.location).toBeUndefined();
    const xss = await ctx.app.inject({ method: 'GET', url: q({ client_id: 'https://client.example/<script>' }) });
    expect(xss.body).not.toContain('<script>');

    for (const [over, error] of [[{ resource: '' }, 'invalid_target'], [{ resource: 'https://other/mcp' }, 'invalid_target'], [{ code_challenge_method: 'plain' }, 'invalid_request'], [{ response_type: 'token' }, 'unsupported_response_type'], [{ scope: 'admin' }, 'invalid_scope']] as const) {
      const r = await ctx.app.inject({ method: 'GET', url: q(over), headers: { cookie: alice.cookie } });
      expect(r.statusCode).toBe(302);
      const loc = new URL(r.headers.location as string);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get('error')).toBe(error);
      expect(loc.searchParams.get('state')).toBe('s1');
      expect(loc.searchParams.get('iss')).toBe(GW);
    }
    // the uppercase-host variant of the resource is accepted (spec robustness)
    const upper = await ctx.app.inject({ method: 'GET', url: q({ resource: 'https://GW.test/mcp' }), headers: { cookie: alice.cookie } });
    expect(upper.headers.location).toMatch(/^\/auth\/consent/);
  });

  it('consent is bound to the user and the cookie, single-use, and deny returns access_denied', async () => {
    const verifier = 'v'.repeat(50);
    const url = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CIMD_URL, redirect_uri: REDIRECT, code_challenge: s256(verifier), code_challenge_method: 'S256', resource: MCP, state: 'st' })}`;
    const a = await ctx.app.inject({ method: 'GET', url, headers: { cookie: alice.cookie } });
    const id = (a.headers.location as string).split('=')[1]!;
    const cookie = String(a.headers['set-cookie']).split(';')[0]!;
    expect((await ctx.as(bob, { method: 'GET', url: `/api/oauth/consent/${id}` })).statusCode).toBe(403);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/oauth/consent/01900000-0000-7000-8000-000000000000' })).statusCode).toBe(404);
    // no consent cookie → 403; no CSRF → 403
    expect((await ctx.as(alice, { method: 'POST', url: `/api/oauth/consent/${id}`, payload: { decision: 'approve' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/oauth/consent/${id}`, headers: { cookie: `${alice.cookie}; ${cookie}`, 'content-type': 'application/json' }, payload: { decision: 'approve' } })).statusCode).toBe(403);
    // bob can't use alice's consent cookie
    expect((await ctx.app.inject({ method: 'POST', url: `/api/oauth/consent/${id}`, headers: { cookie: `${bob.cookie}; ${cookie}`, 'x-csrf-token': bob.csrf, 'content-type': 'application/json' }, payload: { decision: 'approve' } })).statusCode).toBe(403);
    const deny = await ctx.app.inject({ method: 'POST', url: `/api/oauth/consent/${id}`, headers: { cookie: `${alice.cookie}; ${cookie}`, 'x-csrf-token': alice.csrf, 'content-type': 'application/json' }, payload: { decision: 'deny' } });
    const loc = new URL(deny.json().redirectTo);
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ error: 'access_denied', state: 'st', iss: GW });
    // single use
    expect((await ctx.as(alice, { method: 'GET', url: `/api/oauth/consent/${id}` })).statusCode).toBe(404);
    // expiry → 410
    const b = await ctx.app.inject({ method: 'GET', url, headers: { cookie: alice.cookie } });
    const id2 = (b.headers.location as string).split('=')[1]!;
    await ctx.s.dbs.main.db.updateTable('oauth_authz_requests').set({ expires_at: Date.now() - 1 }).where('id', '=', id2).execute();
    expect((await ctx.as(alice, { method: 'GET', url: `/api/oauth/consent/${id2}` })).statusCode).toBe(410);
  });

  it('authorized apps: list and revoke (tokens die on all replicas); admins block clients; DCR can be disabled', async () => {
    const verifier = 'v'.repeat(50);
    const url = new URL(`${GW}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CIMD_URL, redirect_uri: REDIRECT, code_challenge: s256(verifier), code_challenge_method: 'S256', resource: MCP })}`);
    const code = (await browser(url, alice)).redirect.searchParams.get('code')!;
    const tokens = (await ctx.app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CIMD_URL, redirect_uri: REDIRECT, code_verifier: verifier, resource: MCP }).toString() })).json();
    expect((await ctx.s.authenticator.authenticate(`Bearer ${tokens.access_token}`)).ok).toBe(true);
    const grants = (await ctx.as(alice, { method: 'GET', url: '/api/me/oauth-grants' })).json().items;
    expect(grants).toEqual([expect.objectContaining({ client: { name: 'Example IDE', id: CIMD_URL }, scopes: ['mcp:tools'] })]);
    expect((await ctx.as(bob, { method: 'DELETE', url: `/api/me/oauth-grants/${grants[0].id}` })).statusCode).toBe(404);
    expect((await ctx.as(alice, { method: 'DELETE', url: `/api/me/oauth-grants/${grants[0].id}` })).statusCode).toBe(204);
    expect((await ctx.s.authenticator.authenticate(`Bearer ${tokens.access_token}`)).ok).toBe(false);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/me/oauth-grants' })).json().items).toEqual([]);

    const list = (await ctx.as(admin, { method: 'GET', url: '/api/oauth-clients?registration=cimd' })).json();
    expect(list.items).toEqual([expect.objectContaining({ clientId: CIMD_URL, registration: 'cimd', status: 'active', userCount: 0 })]);
    expect((await ctx.as(alice, { method: 'GET', url: '/api/oauth-clients' })).statusCode).toBe(403);
    const blocked = await ctx.as(admin, { method: 'PATCH', url: `/api/oauth-clients/${list.items[0].id}`, payload: { status: 'blocked' } });
    expect(blocked.json().status).toBe('blocked');
    const page = await ctx.app.inject({ method: 'GET', url: url.pathname + url.search, headers: { cookie: alice.cookie } });
    expect(page.statusCode).toBe(400);
    expect(page.body).toContain('blocked');

    // DCR toggle: hidden from metadata and refused
    const md = (await ctx.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(md.registration_endpoint).toBe(`${GW}/oauth/register`);
    expect((await ctx.app.inject({ method: 'GET', url: '/.well-known/openid-configuration' })).json().issuer).toBe(GW);
    await ctx.s.settings.set('dcrEnabled', false);
    expect((await ctx.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json()).not.toHaveProperty('registration_endpoint');
    const reg = await ctx.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [REDIRECT] } });
    expect(reg.statusCode).toBe(403);
    await ctx.s.settings.set('dcrEnabled', true);
    expect((await ctx.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['http://evil.example/cb'] } })).json().error).toBe('invalid_redirect_uri');
    const conf = await ctx.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'client_secret_basic', application_type: 'web' } });
    expect(conf.statusCode).toBe(201);
    expect(conf.json().client_secret).toMatch(/^nr_cs_/);
    // confidential client must authenticate at the token endpoint
    const noAuth = await ctx.app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `grant_type=authorization_code&code=x&client_id=${conf.json().client_id}` });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json().error).toBe('invalid_client');
    const basic = Buffer.from(`${conf.json().client_id}:${conf.json().client_secret}`).toString('base64');
    const withAuth = await ctx.app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, payload: 'grant_type=authorization_code&code=x' });
    expect(withAuth.json().error).toBe('invalid_grant');
    // DCR rate limit: 10/min per IP
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await ctx.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [REDIRECT] } })).statusCode);
    expect(codes).toContain(429);
  });
});
