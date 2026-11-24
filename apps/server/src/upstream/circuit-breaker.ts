import type { Clock } from '../lib/clock.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * Per-server circuit breaker (backend §6): opens after `threshold` consecutive transport
 * failures/timeouts, half-opens after `openMs` with a single probe, closes on success.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(
    private readonly clock: Clock,
    private readonly threshold = 5,
    private readonly openMs = 30_000,
  ) {}

  get state(): CircuitState {
    if (this.openedAt === null) return 'closed';
    return this.clock.now() - this.openedAt >= this.openMs ? 'half_open' : 'open';
  }

  /** True when a request may proceed (the first caller in half-open becomes the probe). */
  tryAcquire(): boolean {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'open' || this.probing) return false;
    this.probing = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.probing = false;
  }

  /** Returns true when this failure opened (or re-opened) the circuit. */
  onFailure(): boolean {
    this.failures++;
    const wasProbe = this.probing;
    this.probing = false;
    if (wasProbe || this.failures >= this.threshold) {
      const opening = this.openedAt === null || wasProbe;
      this.openedAt = this.clock.now();
      return opening;
    }
    return false;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}
