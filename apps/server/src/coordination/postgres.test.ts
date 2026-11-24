import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { MainDB } from '../db/schema.js';
import { recordingKysely } from '../test/fakes/recording-dialect.js';
import { FakeClock } from '../test/fakes/context.js';
import { PostgresCoordination, type ListenClient } from './postgres.js';

class FakeListen extends EventEmitter implements ListenClient {
  queries: string[] = [];
  fail = false;
  async connect() {
    if (this.fail) throw new Error('down');
  }
  async query(t: string) {
    this.queries.push(t);
  }
  async end() {}
}

const log = { warn() {}, info() {} };

describe('postgres coordination', () => {
  it('LISTENs, dispatches NOTIFY payloads by channel and publishes with pg_notify', async () => {
    const { db, driver } = recordingKysely<MainDB>('postgres');
    const fake = new FakeListen();
    const c = new PostgresCoordination(db, new FakeClock(), () => fake, log);
    await c.start();
    expect(fake.queries).toEqual(['LISTEN neurouter_events']);
    const got: unknown[] = [];
    c.subscribe('acl.changed', (p) => got.push(p));
    fake.emit('notification', { channel: 'neurouter_events', payload: JSON.stringify({ c: 'acl.changed', p: { x: 1 } }) });
    fake.emit('notification', { channel: 'neurouter_events', payload: 'garbage' });
    expect(got).toEqual([{ x: 1 }]);
    await c.publish('approval:1', { status: 'approved' });
    expect(driver.queries.at(-1)!.sql).toBe('select pg_notify($1, $2)');
    expect(driver.queries.at(-1)!.parameters).toEqual(['neurouter_events', '{"c":"approval:1","p":{"status":"approved"}}']);
    await expect(c.publish('big', { s: 'x'.repeat(9000) })).rejects.toThrow(/too large/);
    await c.close();
  });

  it('reconnects with backoff and emits resync', async () => {
    const { db } = recordingKysely<MainDB>('postgres');
    const clients: FakeListen[] = [];
    const c = new PostgresCoordination(db, new FakeClock(), () => {
      const f = new FakeListen();
      clients.push(f);
      return f;
    }, log, () => 1);
    await c.start();
    let resyncs = 0;
    c.subscribe('resync', () => resyncs++);
    clients[0]!.emit('error', new Error('boom'));
    await new Promise((r) => setTimeout(r, 20));
    expect(clients).toHaveLength(2);
    expect(resyncs).toBe(1);
    await c.close();
  });

  it('waitFor resolves from the poll fallback when NOTIFY is unavailable', async () => {
    const { db } = recordingKysely<MainDB>('postgres');
    const c = new PostgresCoordination(db, new FakeClock(), () => new FakeListen(), log);
    let polls = 0;
    const r = await c.waitFor('approval:1', (p) => (p as { status: string }).status !== 'pending', { timeoutMs: 1000, pollEveryMs: 5, poll: async () => (++polls >= 2 ? { status: 'approved' } : { status: 'pending' }) });
    expect(r).toEqual({ status: 'approved' });
  });

  it('compiles lease and advisory-lock SQL', async () => {
    const { db, driver } = recordingKysely<MainDB>('postgres');
    const c = new PostgresCoordination(db, new FakeClock(1000), () => new FakeListen(), log);
    expect(await c.acquireLease('job', 'me', 500)).toBe(false); // recording driver returns no rows
    expect(driver.queries.at(-1)!.sql).toMatch(/insert into leases[\s\S]*on conflict \(name\) do update[\s\S]*where leases.expires_at < \$4 or leases.holder = \$5/);
    await c.withLock('refresh:u:s', 1000, async () => 1);
    expect(driver.queries.some((q) => q.sql === 'select pg_advisory_xact_lock(hashtext($1))')).toBe(true);
  });
});
