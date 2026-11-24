/** Pure token-bucket math (backend §13). Times are epoch ms; rates are tokens per ms. */
export interface BucketState {
  tokens: number;
  updatedAt: number;
}

export interface BucketConfig {
  capacity: number;
  refillPerMs: number;
}

export function refill(state: BucketState, now: number, cfg: BucketConfig): BucketState {
  const elapsed = Math.max(0, now - state.updatedAt);
  return { tokens: Math.min(cfg.capacity, state.tokens + elapsed * cfg.refillPerMs), updatedAt: Math.max(now, state.updatedAt) };
}

/** Takes `n` tokens if available. `retryAfterMs` is when `n` tokens will be available otherwise. */
export function take(state: BucketState, n: number, cfg: BucketConfig): { ok: boolean; state: BucketState; retryAfterMs: number } {
  if (state.tokens >= n) return { ok: true, state: { ...state, tokens: state.tokens - n }, retryAfterMs: 0 };
  const missing = n - state.tokens;
  return { ok: false, state, retryAfterMs: cfg.refillPerMs > 0 ? Math.ceil(missing / cfg.refillPerMs) : Number.POSITIVE_INFINITY };
}

/** `perMinute` steady rate with `burst` capacity. */
export function perMinute(perMin: number, burst: number): BucketConfig {
  return { capacity: Math.max(1, burst), refillPerMs: perMin / 60_000 };
}
