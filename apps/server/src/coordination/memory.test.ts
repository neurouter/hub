import { describe, expect, it } from 'vitest';
import { MemoryCoordination } from './memory.js';

const clockAt = (t: { now: number }) => ({ now: () => t.now });

describe('MemoryCoordination', () => {
  it('publishes to subscribers and unsubscribes', async () => {
    const c = new MemoryCoordination();
    const got: unknown[] = [];
    const off = c.subscribe('ch', (p) => got.push(p));
    await c.publish('ch', { a: 1 });
    await new Promise((r) => setTimeout(r, 0));
    off();
    await c.publish('ch', { a: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([{ a: 1 }]);
  });

  it('waitFor resolves on a matching event, null on timeout, via poll, and rejects on abort', async () => {
    const c = new MemoryCoordination();
    const p = c.waitFor('approval:1', (x) => (x as { status: string }).status !== 'pending', { timeoutMs: 1000 });
    await c.publish('approval:1', { status: 'pending' });
    await c.publish('approval:1', { status: 'approved' });
    await expect(p).resolves.toEqual({ status: 'approved' });

    await expect(c.waitFor('x', () => true, { timeoutMs: 10 })).resolves.toBeNull();

    const polled = c.waitFor('y', (x) => x === 'done', { timeoutMs: 1000, poll: async () => 'done', pollEveryMs: 5 });
    await expect(polled).resolves.toBe('done');

    const ac = new AbortController();
    const aborted = c.waitFor('z', () => true, { timeoutMs: 1000, signal: ac.signal });
    ac.abort(new Error('client gone'));
    await expect(aborted).rejects.toThrow('client gone');
  });

  it('leases are exclusive until expiry or release', async () => {
    const t = { now: 0 };
    const c = new MemoryCoordination(clockAt(t));
    expect(await c.acquireLease('job', 'a', 1000)).toBe(true);
    expect(await c.acquireLease('job', 'b', 1000)).toBe(false);
    expect(await c.acquireLease('job', 'a', 1000)).toBe(true); // renew
    t.now = 1500;
    expect(await c.acquireLease('job', 'b', 1000)).toBe(true);
    await c.releaseLease('job', 'a'); // not the holder: no-op
    expect(await c.acquireLease('job', 'a', 1000)).toBe(false);
    await c.releaseLease('job', 'b');
    expect(await c.acquireLease('job', 'a', 1000)).toBe(true);
  });

  it('withLock serializes critical sections per name', async () => {
    const c = new MemoryCoordination();
    const order: string[] = [];
    const slow = c.withLock('k', 1000, async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('a:end');
      return 1;
    });
    const fast = c.withLock('k', 1000, async () => {
      order.push('b');
      return 2;
    });
    expect(await Promise.all([slow, fast])).toEqual([1, 2]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
    await expect(c.withLock('k', 10, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(c.withLock('k', 10, async () => 3)).resolves.toBe(3);
  });
});
