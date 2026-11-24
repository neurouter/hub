/** JSON-serializable payloads only: the Postgres backend sends them through NOTIFY. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Unsubscribe = () => void;

export interface WaitForOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Correctness fallback (DB read) when no signal arrives (backend §12.1). */
  poll?: () => Promise<Json | null>;
  pollEveryMs?: number;
}

/** Token-bucket store; implemented in Phase 1 step 4 (§13). */
export interface RateLimitStore {
  take(key: string, opts: { capacity: number; refillPerMs: number; cost?: number }): Promise<{ allowed: boolean; retryAfterMs: number }>;
}

/** Cross-replica coordination (backend §12.1). Memory for SQLite/dev, Postgres in prod. */
export interface CoordinationStore {
  readonly backend: 'memory' | 'postgres';
  publish(channel: string, payload: Json): Promise<void>;
  subscribe(channel: string, fn: (payload: Json) => void): Unsubscribe;
  /** Resolves with the first payload matching `predicate` (or a poll result), or null on timeout. Rejects on abort. */
  waitFor(channel: string, predicate: (p: Json) => boolean, opts: WaitForOptions): Promise<Json | null>;
  acquireLease(name: string, holder: string, ttlMs: number): Promise<boolean>;
  releaseLease(name: string, holder: string): Promise<void>;
  withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
  rateLimit?: RateLimitStore;
  close(): Promise<void>;
}
