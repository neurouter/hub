import { describe, expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { api } from '@neurouter/shared';
import { server } from '@/test/msw-server';
import { ApiContractError, ApiError, apiFetch, applyServerErrors, setCsrfToken } from './api-client';

describe('apiFetch', () => {
  it('parses responses with the contract schema', async () => {
    const me = await apiFetch(api.me.me);
    expect(me.org.name).toBe('Acme Corp');
  });

  it('maps problem+json to ApiError with field errors and retry-after', async () => {
    server.use(
      http.post('/api/groups', () =>
        HttpResponse.json(
          { type: 'https://neurouter.dev/problems/validation-failed', title: 'Validation failed', status: 422, code: 'validation_failed', requestId: 'r1', detail: '1 field is invalid', errors: [{ path: ['name'], message: 'Required', code: 'too_small' }] },
          { status: 422, headers: { 'content-type': 'application/problem+json', 'retry-after': '3' } },
        ),
      ),
    );
    const err = await apiFetch(api.groups.create, { body: { name: '' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'validation_failed', requestId: 'r1', retryAfterSec: 3 });
    const setError = vi.fn();
    expect(applyServerErrors({ setError }, err)).toBe(1);
    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'Required' });
    expect(applyServerErrors({ setError }, new Error('x'))).toBe(0);
  });

  it('turns non-JSON gateway errors into a synthetic ApiError', async () => {
    server.use(http.get('/api/me', () => new HttpResponse('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })));
    await expect(apiFetch(api.me.me)).rejects.toMatchObject({ status: 502, code: 'bad_gateway' });
  });

  it('reports network failures', async () => {
    server.use(http.get('/api/me', () => HttpResponse.error()));
    await expect(apiFetch(api.me.me)).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('sends the CSRF token on mutations only, with JSON bodies, same-origin', async () => {
    setCsrfToken('tok-1');
    const fetchImpl = vi.fn(async () => HttpResponse.json({ redirectTo: '/auth/logged-out' }));
    await apiFetch(api.auth.logout, { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/logout');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('tok-1');
    expect(init.credentials).toBe('same-origin');

    fetchImpl.mockClear();
    fetchImpl.mockResolvedValueOnce(HttpResponse.json({ items: [], nextCursor: null }));
    await apiFetch(api.users.list, { fetchImpl, query: { role: 'admin', status: undefined, q: '' } });
    const [getUrl, getInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(getUrl).toBe('/api/users?role=admin');
    expect((getInit.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
    setCsrfToken(null);
  });

  it('fills path params and repeats array query keys', async () => {
    const fetchImpl = vi.fn(async () => HttpResponse.json({ items: [], nextCursor: null }));
    await apiFetch(api.audit.events, { fetchImpl, query: { from: '2026-11-23T00:00:00Z', to: '2026-11-24T00:00:00Z', decision: ['allowed', 'denied_acl'] } });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('/api/audit/events?from=2026-11-23T00%3A00%3A00Z&to=2026-11-24T00%3A00%3A00Z&decision=allowed&decision=denied_acl');
    const empty = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(apiFetch(api.groups.delete, { fetchImpl: empty, params: { id: 'g 1' } })).resolves.toBeUndefined();
    expect((empty.mock.calls[0] as unknown as [string])[0]).toBe('/api/groups/g%201');
  });

  it('throws ApiContractError when the server drifts from the contract', async () => {
    server.use(http.get('/api/me/badges', () => HttpResponse.json({ pendingApprovals: 'many' })));
    const err = await apiFetch(api.me.badges).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiContractError);
    expect((err as ApiContractError).issues.length).toBeGreaterThan(0);
  });
});
