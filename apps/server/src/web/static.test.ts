import { describe, expect, it } from 'vitest';
import { cacheControlFor, wantsSpa } from './static.js';

describe('static rules', () => {
  it('caches hashed assets forever and the entry points never', () => {
    expect(cacheControlFor('/assets/x-1.js')).toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor('/index.html')).toBe('no-cache');
    expect(cacheControlFor('theme-init.js')).toBe('no-cache');
    expect(cacheControlFor('/favicon.svg')).toBe('public, max-age=3600');
  });
  it.each([
    ['GET', '/catalog', 'text/html', true],
    ['GET', '/admin/servers/1', '*/*', true],
    ['GET', '/api/me', 'text/html', false],
    ['GET', '/mcp', 'text/html', false],
    ['GET', '/oauth/authorize', 'text/html', false],
    ['GET', '/.well-known/oauth-protected-resource', 'text/html', false],
    ['GET', '/metrics', 'text/html', false],
    ['GET', '/catalog', 'application/json', false],
    ['POST', '/catalog', 'text/html', false],
  ])('%s %s (%s) → %s', (method, url, accept, expected) => {
    expect(wantsSpa({ method, url, headers: { accept } } as never)).toBe(expected);
  });
});
