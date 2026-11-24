import { describe, expect, it } from 'vitest';
import { ALL_ENDPOINTS } from '@neurouter/shared';
import { createContractHandlers } from './handlers';
import { server } from '@/test/msw-server';

describe('contract-generated MSW handlers', () => {
  it('creates one handler per contract endpoint', () => {
    expect(createContractHandlers()).toHaveLength(ALL_ENDPOINTS.length);
  });

  it('answers 501 problem+json for endpoints without a fixture', async () => {
    server.use(...createContractHandlers({}));
    const res = await fetch('/api/servers/abc');
    expect(res.status).toBe(501);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect((await res.json()).detail).toMatch(/servers\.get/);
  });

  it('validates fixtures against the contract and supports resolvers', async () => {
    server.use(...createContractHandlers({ 'groups.get': { id: 'g1' }, 'groups.delete': null, 'catalog.tags': () => ({ tags: [{ name: 'dev', count: 2 }] }) }));
    expect((await fetch('/api/groups/g1')).status).toBe(500);
    expect((await fetch('/api/groups/g1', { method: 'DELETE' })).status).toBe(204);
    expect(await (await fetch('/api/catalog/tags')).json()).toEqual({ tags: [{ name: 'dev', count: 2 }] });
  });
});
