import { describe, expect, it } from 'vitest';
import { cacheTtlMs, CimdResolver, CIMD_MAX_CACHE_MS, CIMD_MIN_CACHE_MS, parseClientMetadata, validateClientIdUrl } from './cimd.js';
import { authorizationServerMetadata, parseScope } from './metadata.js';
import { s256, verifyPkceS256 } from './pkce.js';
import { isLoopbackRedirect, redirectUriMatches, validRedirectUri, withParams } from './redirect-uri.js';
import { uuidFromHash } from './tokens.service.js';

const URL1 = 'https://app.example/oauth/client.json';
const doc = (over: Record<string, unknown> = {}) => ({ client_id: URL1, client_name: 'Example', redirect_uris: ['http://127.0.0.1:3000/cb'], ...over });

describe('PKCE', () => {
  it('verifies S256 (RFC 7636 appendix B vector) and rejects malformed verifiers', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(s256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(verifyPkceS256(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(verifyPkceS256('x'.repeat(43), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
    expect(verifyPkceS256('short', s256('short'))).toBe(false);
    expect(verifyPkceS256(undefined, 'x')).toBe(false);
  });
});

describe('redirect URIs', () => {
  it('match exactly, except any port for registered loopback URIs', () => {
    const reg = ['https://app.example/cb', 'http://127.0.0.1/callback', 'http://localhost:8080/cb'];
    expect(redirectUriMatches(reg, 'https://app.example/cb')).toBe(true);
    expect(redirectUriMatches(reg, 'https://app.example/cb/')).toBe(false);
    expect(redirectUriMatches(reg, 'https://app.example/cb?x=1')).toBe(false);
    expect(redirectUriMatches(reg, 'http://127.0.0.1:53412/callback')).toBe(true);
    expect(redirectUriMatches(reg, 'http://127.0.0.1:53412/other')).toBe(false);
    expect(redirectUriMatches(reg, 'http://localhost:9999/cb')).toBe(true);
    expect(redirectUriMatches(reg, 'http://[::1]:9999/cb')).toBe(false); // host must match too
    expect(redirectUriMatches(reg, 'https://evil.example/cb')).toBe(false);
    expect(isLoopbackRedirect('http://[::1]:1/x')).toBe(true);
    expect(isLoopbackRedirect('https://127.0.0.1/x')).toBe(false);
  });

  it('registration rules', () => {
    expect(validRedirectUri('https://a.example/cb', 'web')).toBeNull();
    expect(validRedirectUri('http://a.example/cb', 'native')).toMatch(/loopback/);
    expect(validRedirectUri('https://a.example/cb#x', 'native')).toMatch(/fragment/);
    expect(validRedirectUri('com.example.app:/cb', 'native')).toBeNull();
    expect(validRedirectUri('com.example.app:/cb', 'web')).toMatch(/https/);
    expect(validRedirectUri('myapp:/cb', 'native')).toMatch(/reverse-domain/);
    expect(validRedirectUri('javascript:alert(1)', 'native')).toMatch(/not allowed/);
    expect(withParams('https://a.example/cb?k=v', { code: 'c', state: null, iss: 'https://gw' })).toBe('https://a.example/cb?k=v&code=c&iss=https%3A%2F%2Fgw');
  });
});

describe('CIMD (draft-03)', () => {
  it('client_id URL rules', () => {
    expect(validateClientIdUrl(URL1)).toBeNull();
    expect(validateClientIdUrl('http://app.example/c.json')).toMatch(/https/);
    expect(validateClientIdUrl('https://app.example/')).toMatch(/path/);
    expect(validateClientIdUrl('https://app.example')).toMatch(/path|normalized/);
    expect(validateClientIdUrl('https://app.example/c.json#f')).toMatch(/fragment/);
    expect(validateClientIdUrl('https://u:p@app.example/c.json')).toMatch(/userinfo/);
    expect(validateClientIdUrl('https://app.example/a/../c.json')).toMatch(/dot segments/);
    expect(validateClientIdUrl('https://APP.example/c.json')).toMatch(/normalized/);
  });

  it('document validation: exact client_id, no secrets, auth none, grant intersection, same-host logo', () => {
    const m = parseClientMetadata(URL1, doc({ logo_uri: 'https://app.example/logo.png', grant_types: ['authorization_code', 'refresh_token', 'client_credentials'] }));
    expect(m).toMatchObject({ client_name: 'Example', token_endpoint_auth_method: 'none', logo_uri: 'https://app.example/logo.png', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    expect(parseClientMetadata(URL1, doc({ logo_uri: 'https://cdn.other/logo.png' })).logo_uri).toBeNull();
    expect(() => parseClientMetadata(URL1, doc({ client_id: `${URL1}?x` }))).toThrow(/exactly match/);
    expect(() => parseClientMetadata(URL1, doc({ client_secret: 'x' }))).toThrow(/client_secret/);
    expect(() => parseClientMetadata(URL1, doc({ token_endpoint_auth_method: 'private_key_jwt' }))).toThrow(/private_key_jwt/);
    expect(() => parseClientMetadata(URL1, doc({ token_endpoint_auth_method: 'client_secret_basic' }))).toThrow(/not allowed/);
    expect(() => parseClientMetadata(URL1, doc({ client_name: undefined }))).toThrow(/client_name/);
    expect(() => parseClientMetadata(URL1, doc({ redirect_uris: [] }))).toThrow(/redirect_uris/);
    expect(() => parseClientMetadata(URL1, doc({ redirect_uris: ['http://evil.example/cb'] }))).toThrow(/loopback/);
    expect(() => parseClientMetadata(URL1, doc({ grant_types: ['client_credentials'] }))).toThrow(/overlap/);
    expect(() => parseClientMetadata(URL1, [])).toThrow(/JSON object/);
  });

  it('cache lifetime clamps to [5 min, 24 h]; no-store → minimum', () => {
    expect(cacheTtlMs(null)).toBe(CIMD_MIN_CACHE_MS);
    expect(cacheTtlMs('max-age=600')).toBe(600_000);
    expect(cacheTtlMs('public, max-age=9999999')).toBe(CIMD_MAX_CACHE_MS);
    expect(cacheTtlMs('no-store')).toBe(CIMD_MIN_CACHE_MS);
  });

  it('resolver: no redirects, non-200 and oversized documents are errors and never cached; valid documents are cached', async () => {
    let now = 0;
    let calls = 0;
    let respond: () => Response = () => Response.json(doc(), { headers: { 'cache-control': 'max-age=600' } });
    const fetch = async (_u: string | URL | Request, init?: RequestInit) => {
      calls++;
      expect(init?.redirect).toBe('manual');
      return respond();
    };
    const r = new CimdResolver(fetch, () => now);
    expect((await r.resolve(URL1)).meta.client_name).toBe('Example');
    await r.resolve(URL1);
    expect(calls).toBe(1);
    now += 600_001;
    respond = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/c.json' } });
    await expect(r.resolve(URL1)).rejects.toThrow(/HTTP 302/);
    respond = () => new Response('x'.repeat(6000), { status: 200 });
    await expect(r.resolve(URL1)).rejects.toThrow(/larger than 5120/);
    respond = () => new Response('{not json', { status: 200 });
    await expect(r.resolve(URL1)).rejects.toThrow(/not valid JSON/);
    const before = calls;
    await expect(r.resolve(URL1)).rejects.toThrow();
    expect(calls).toBe(before + 1); // errors are not cached
    await expect(r.resolve('https://app.example/')).rejects.toThrow(/path/);
  });
});

describe('AS metadata', () => {
  it('advertises PKCE S256, CIMD, iss and (optionally) DCR', () => {
    const m = authorizationServerMetadata('https://gw.example', { dcrEnabled: true });
    expect(m).toMatchObject({ issuer: 'https://gw.example', code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true, registration_endpoint: 'https://gw.example/oauth/register', scopes_supported: ['mcp:tools'] });
    expect(authorizationServerMetadata('https://gw.example', { dcrEnabled: false })).not.toHaveProperty('registration_endpoint');
    expect(parseScope(undefined)).toEqual(['mcp:tools']);
    expect(parseScope('mcp:tools mcp:tools')).toEqual(['mcp:tools']);
    expect(parseScope('admin')).toBeNull();
  });

  it('token families derive a stable uuid from the code hash', () => {
    const a = uuidFromHash(Buffer.from('a'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidFromHash(Buffer.from('a'))).toBe(a);
    expect(uuidFromHash(Buffer.from('b'))).not.toBe(a);
  });
});
