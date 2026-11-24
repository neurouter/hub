import { EventEmitter } from 'node:events';
import { systemClock, type Clock } from '../lib/clock.js';
import type { CoordinationStore, Json, Unsubscribe, WaitForOptions } from './types.js';

/** Single-process coordination (dev / SQLite). Exact and in-memory. */
export class MemoryCoordination implements CoordinationStore {
  readonly backend = 'memory' as const;
  private readonly bus = new EventEmitter();
  private readonly leases = new Map<string, { holder: string; expiresAt: number }>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly clock: Clock = systemClock) {
    this.bus.setMaxListeners(0);
  }

  async publish(channel: string, payload: Json): Promise<void> {
    // deliver asynchronously, like a real bus
    queueMicrotask(() => this.bus.emit(channel, payload));
  }

  subscribe(channel: string, fn: (payload: Json) => void): Unsubscribe {
    this.bus.on(channel, fn);
    return () => this.bus.off(channel, fn);
  }

  waitFor(channel: string, predicate: (p: Json) => boolean, opts: WaitForOptions): Promise<Json | null> {
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(opts.signal.reason ?? new Error('aborted'));
      let done = false;
      const timers: NodeJS.Timeout[] = [];
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        unsubscribe();
        for (const t of timers) {
          clearTimeout(t);
          clearInterval(t);
        }
        opts.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => finish(() => reject(opts.signal?.reason ?? new Error('aborted')));
      const unsubscribe = this.subscribe(channel, (p) => {
        if (predicate(p)) finish(() => resolve(p));
      });
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      timers.push(setTimeout(() => finish(() => resolve(null)), opts.timeoutMs));
      if (opts.poll) {
        const poll = opts.poll;
        timers.push(
          setInterval(() => {
            poll().then(
              (p) => {
                if (p !== null && predicate(p)) finish(() => resolve(p));
              },
              () => {},
            );
          }, opts.pollEveryMs ?? 2000),
        );
      }
    });
  }

  async acquireLease(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const cur = this.leases.get(name);
    if (cur && cur.expiresAt > now && cur.holder !== holder) return false;
    this.leases.set(name, { holder, expiresAt: now + ttlMs });
    return true;
  }

  async releaseLease(name: string, holder: string): Promise<void> {
    if (this.leases.get(name)?.holder === holder) this.leases.delete(name);
  }

  /** Serializes critical sections per name within this process. */
  async withLock<T>(name: string, _ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => mine);
    this.locks.set(name, chained);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(name) === chained) this.locks.delete(name);
    }
  }

  async close(): Promise<void> {
    this.bus.removeAllListeners();
    this.leases.clear();
  }
}
