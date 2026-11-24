import { describe, expect, it } from 'vitest';
import { MemoryCoordination } from '../coordination/memory.js';
import { InflightCalls, inspectJsonRpc, LegacyClientInfo } from './inflight.js';

describe('inspectJsonRpc', () => {
  it('finds tools/call ids, cancelled requestIds and initialize clientInfo (single and batch)', () => {
    expect(inspectJsonRpc(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } }))).toEqual({ calls: [7], cancels: [], initialize: null });
    expect(
      inspectJsonRpc(
        JSON.stringify([
          { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'a', reason: 'esc' } },
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-code', version: '2.1' } } },
        ]),
      ),
    ).toEqual({ calls: [], cancels: ['a'], initialize: { name: 'claude-code', version: '2.1', protocolVersion: '2025-11-25' } });
  });

  it('ignores malformed bodies and ids', () => {
    expect(inspectJsonRpc(undefined)).toEqual({ calls: [], cancels: [], initialize: null });
    expect(inspectJsonRpc('{not json')).toEqual({ calls: [], cancels: [], initialize: null });
    expect(inspectJsonRpc(JSON.stringify([null, 3, { method: 'tools/call', id: { x: 1 } }, { method: 'notifications/cancelled', params: { requestId: null } }]))).toEqual({ calls: [], cancels: [], initialize: null });
    expect(inspectJsonRpc(JSON.stringify({ method: 'initialize', params: { clientInfo: { name: 'n'.repeat(500) } } })).initialize).toEqual({ name: 'n'.repeat(200), version: null, protocolVersion: null });
  });
});

describe('InflightCalls', () => {
  it('aborts the registered call for (credential, id) and nothing else', async () => {
    const f = new InflightCalls();
    const a = new AbortController();
    const b = new AbortController();
    f.register('key-1', 1, a);
    f.register('key-2', 1, b);
    expect(await f.cancel('key-1', 1)).toBe('local');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    // string and number ids are distinct
    const c = new AbortController();
    f.register('key-2', '1', c);
    await f.cancel('key-2', '1');
    expect(b.signal.aborted).toBe(false);
    expect(c.signal.aborted).toBe(true);
  });

  it('release unregisters; ambiguous duplicates are not cancelled', async () => {
    const f = new InflightCalls();
    const a = new AbortController();
    const release = f.register('k', 5, a);
    expect(f.size).toBe(1);
    release();
    expect(f.size).toBe(0);
    expect(await f.cancel('k', 5)).toBe('relayed');
    expect(a.signal.aborted).toBe(false);
    const x = new AbortController();
    const y = new AbortController();
    f.register('k', 9, x);
    f.register('k', 9, y);
    expect(await f.cancel('k', 9)).toBe('ambiguous');
    expect(x.signal.aborted || y.signal.aborted).toBe(false);
  });

  it('relays a cancel to the replica that holds the call', async () => {
    const coord = new MemoryCoordination();
    const replicaA = new InflightCalls(coord);
    const replicaB = new InflightCalls(coord);
    const held = new AbortController();
    replicaA.register('k', 3, held);
    expect(await replicaB.cancel('k', 3)).toBe('relayed');
    await new Promise((r) => setTimeout(r, 0));
    expect(held.signal.aborted).toBe(true);
  });
});

describe('LegacyClientInfo', () => {
  it('remembers per credential (session-specific first), evicts LRU and expires', () => {
    let now = 0;
    const m = new LegacyClientInfo(2, 1000, () => now);
    m.remember('k1', 'sess', { name: 'a', version: '1', protocolVersion: '2025-11-25' });
    expect(m.get('k1', 'sess')?.name).toBe('a');
    expect(m.get('k1', null)?.name).toBe('a');
    expect(m.get('k1', 'other')?.name).toBe('a');
    m.remember('k2', null, { name: 'b', version: null, protocolVersion: null });
    m.remember('k3', null, { name: 'c', version: null, protocolVersion: null });
    expect(m.get('k1', 'sess')).toBeNull(); // both k1 entries evicted (max 2 entries)
    expect(m.get('k2', null)?.name).toBe('b');
    now = 2000;
    expect(m.get('k2', null)).toBeNull();
  });
});
