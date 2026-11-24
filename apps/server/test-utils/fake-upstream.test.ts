import { afterEach, describe, expect, it } from 'vitest';
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { FakeUpstream } from './fake-upstream.js';

describe('FakeUpstream', () => {
  const ups: FakeUpstream[] = [];
  afterEach(async () => {
    for (const u of ups.splice(0)) await u.close();
  });

  it.each([
    ['modern', 'modern'],
    ['legacy', 'legacy'],
  ] as const)('%s variant negotiates the %s era and serves tools', async (variant, era) => {
    const up = new FakeUpstream({ variant });
    ups.push(up);
    const c = new Client({ name: 't', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(new StreamableHTTPClientTransport(new URL(up.url), { fetch: up.fetch }));
    expect(c.getProtocolEra()).toBe(era);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
    const r = await c.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(r.content).toEqual([{ type: 'text', text: '{"text":"hi"}' }]);
    await c.close();
  });

  it('sse variant serves the legacy HTTP+SSE transport', async () => {
    const up = new FakeUpstream({ variant: 'sse' });
    ups.push(up);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new SSEClientTransport(new URL(up.url), { fetch: up.fetch }));
    expect((await c.listTools()).tools).toHaveLength(1);
    expect((await c.callTool({ name: 'echo', arguments: { text: 'x' } })).content).toEqual([{ type: 'text', text: '{"text":"x"}' }]);
    await c.close();
  });

  it('requires auth when configured and can fail requests', async () => {
    const up = new FakeUpstream({ requireAuth: { header: 'authorization', value: 'Bearer s' } });
    ups.push(up);
    expect((await up.fetch(up.url, { method: 'POST', body: '{}' })).status).toBe(401);
    up.failNext = 1;
    expect((await up.fetch(up.url, { method: 'POST', body: '{}', headers: { authorization: 'Bearer s' } })).status).toBe(503);
  });
});
