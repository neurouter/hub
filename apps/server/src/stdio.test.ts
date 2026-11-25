import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createInspectionServer } from './stdio.js';

describe('stdio inspection endpoint', () => {
  it('lists the real meta-tools and refuses calls', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createInspectionServer().connect(a);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(b);
    expect(c.getServerVersion()).toMatchObject({ name: 'neurouter', title: 'Neurouter Hub' });
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(['call_tool', 'search_tools']);
    const r = await c.callTool({ name: 'search_tools', arguments: { query: 'x' } });
    expect(r.isError).toBe(true);
    await c.close();
  });
});
