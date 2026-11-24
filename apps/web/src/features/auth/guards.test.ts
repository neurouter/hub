import { describe, expect, it } from 'vitest';
import { isRedirect } from '@tanstack/react-router';
import { HttpResponse, http } from 'msw';
import { createQueryClient } from '@/app/query-client';
import { meFixture } from '@/mocks/fixtures';
import { server } from '@/test/msw-server';
import { unauthenticated } from '@/test/render';
import { ForbiddenError, isForbiddenError, isSafeReturnTo, landingPath, requireAnyCapability, requireAuth } from './guards';
import { getCsrfToken } from '@/lib/api-client';

describe('requireAuth', () => {
  it('returns /api/me and stores the CSRF token', async () => {
    const queryClient = createQueryClient();
    const me = await requireAuth({ context: { queryClient }, location: { href: '/catalog' } });
    expect(me.user.email).toBe('dana.whitfield@acme.example');
    expect(getCsrfToken()).toBe('csrf-test-token');
  });

  it('redirects to /auth/login with returnTo on 401', async () => {
    server.use(http.get('/api/me', unauthenticated));
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    try {
      await requireAuth({ context: { queryClient }, location: { href: '/admin/tools?status=pending_review' } });
      expect.unreachable();
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      const opts = (err as { options: { to: string; search: { returnTo: string } } }).options;
      expect(opts.to).toBe('/auth/login');
      expect(opts.search.returnTo).toBe('/admin/tools?status=pending_review');
    }
  });

  it('rethrows other errors', async () => {
    server.use(http.get('/api/me', () => HttpResponse.text('bad gateway', { status: 502 })));
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    await expect(requireAuth({ context: { queryClient }, location: { href: '/' } })).rejects.toMatchObject({ status: 502, code: 'bad_gateway' });
  });
});

describe('requireAnyCapability', () => {
  it('passes with any matching capability and throws ForbiddenError otherwise', () => {
    expect(() => requireAnyCapability(meFixture('user'), ['portal:use'])).not.toThrow();
    expect(() => requireAnyCapability(meFixture('auditor'), ['users:read'])).not.toThrow();
    expect(() => requireAnyCapability(meFixture('user'), ['users:read', 'audit:read'])).toThrow(ForbiddenError);
    expect(() => requireAnyCapability(meFixture('owner'), ['servers:create'])).toThrow(ForbiddenError);
    expect(() => requireAnyCapability(meFixture('owner'), ['servers:write'], { serverId: 'not-mine' })).toThrow(ForbiddenError);
    expect(isForbiddenError(new ForbiddenError(['users:read']))).toBe(true);
    expect(isForbiddenError(new Error('x'))).toBe(false);
  });
});

describe('landingPath', () => {
  it('routes each role to its landing page', () => {
    expect(landingPath(meFixture('admin'))).toBe('/observability');
    expect(landingPath(meFixture('auditor'))).toBe('/observability');
    expect(landingPath(meFixture('owner'), { pendingApprovals: 2 })).toBe('/admin/approvals');
    expect(landingPath(meFixture('owner'), { pendingApprovals: 0 })).toBe('/catalog');
    expect(landingPath(meFixture('owner'), null)).toBe('/catalog');
    expect(landingPath(meFixture('user'))).toBe('/catalog');
  });
});

describe('isSafeReturnTo', () => {
  it.each([['/catalog', true], ['//evil.com', false], ['https://evil.com', false], ['javascript:alert(1)', false]])('%s → %s', (v, ok) => {
    expect(isSafeReturnTo(v)).toBe(ok);
  });
});
