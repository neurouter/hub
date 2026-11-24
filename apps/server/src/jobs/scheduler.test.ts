import { describe, expect, it, vi } from 'vitest';
import { MemoryCoordination } from '../coordination/memory.js';
import { JobScheduler } from './scheduler.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('JobScheduler', () => {
  it('runs a job under its lease and releases it', async () => {
    const coord = new MemoryCoordination();
    const s = new JobScheduler(coord, 'replica-a', log);
    const run = vi.fn(async () => {});
    s.register({ name: 'cleanup', schedule: '*/5 * * * *', run });
    expect(await s.runOnce('cleanup')).toBe('ok');
    expect(run).toHaveBeenCalledOnce();
    expect(await coord.acquireLease('job:cleanup', 'replica-b', 1000)).toBe(true);
  });

  it('skips when another replica holds the lease', async () => {
    const coord = new MemoryCoordination();
    await coord.acquireLease('job:cleanup', 'replica-b', 60_000);
    const s = new JobScheduler(coord, 'replica-a', log);
    const run = vi.fn(async () => {});
    s.register({ name: 'cleanup', schedule: '* * * * *', run });
    expect(await s.runOnce('cleanup')).toBe('skipped_lease');
    expect(run).not.toHaveBeenCalled();
  });

  it('never overlaps runs of the same job and reports errors', async () => {
    const coord = new MemoryCoordination();
    const s = new JobScheduler(coord, 'a', log);
    let release!: () => void;
    s.register({ name: 'slow', schedule: '* * * * *', run: () => new Promise<void>((r) => (release = r)) });
    const first = s.runOnce('slow');
    await new Promise((r) => setTimeout(r, 0));
    expect(await s.runOnce('slow')).toBe('skipped_running');
    release();
    expect(await first).toBe('ok');

    s.register({ name: 'bad', schedule: '* * * * *', run: async () => { throw new Error('nope'); } });
    expect(await s.runOnce('bad')).toBe('error');
    expect(log.error).toHaveBeenCalled();
  });

  it('validates registrations', () => {
    const s = new JobScheduler(new MemoryCoordination(), 'a', log);
    s.register({ name: 'x', schedule: '0 3 * * *', run: async () => {} });
    expect(() => s.register({ name: 'x', schedule: '0 3 * * *', run: async () => {} })).toThrow(/already/);
    expect(() => s.register({ name: 'y', schedule: 'not a cron', run: async () => {} })).toThrow();
    expect(s.list()).toEqual(['x']);
  });

  it('starts and stops cleanly', async () => {
    const s = new JobScheduler(new MemoryCoordination(), 'a', log);
    const run = vi.fn(async () => {});
    s.register({ name: 'boot', schedule: '0 0 1 1 *', runOnStart: true, run });
    s.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await s.stop();
  });
});
