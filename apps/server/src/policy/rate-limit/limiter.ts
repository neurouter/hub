import type { RateLimitStore } from '../../coordination/types.js';
import type { SettingsService } from '../../settings/settings.service.js';
import { perMinute } from './token-bucket.js';

export type LimitScope = 'agent' | 'agent_tool' | 'tool';

export interface LimitCheck {
  scope: LimitScope;
  key: string;
  perMinute: number;
  burst: number;
}

export type LimitResult = { allowed: true } | { allowed: false; scope: LimitScope; retryAfterMs: number };

/**
 * Per-call checks (backend §13): agent, agent×tool, and the optional global per-tool limit.
 * All must pass; the first failure is reported with a retry-after.
 */
export class RateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly settings: SettingsService,
  ) {}

  async checksFor(p: {
    agentId: string;
    agentLimit: { perMinute: number; burst: number } | null;
    toolId: string;
    toolLimit: { perMinute: number; burst: number } | null;
    serverPerToolPerMinute: number | null;
  }): Promise<LimitCheck[]> {
    const d = await this.settings.get('rateLimitDefaults');
    const checks: LimitCheck[] = [
      { scope: 'agent', key: `agent:${p.agentId}`, ...(p.agentLimit ?? { perMinute: d.agentPerMinute, burst: d.agentBurst }) },
      { scope: 'agent_tool', key: `agent_tool:${p.agentId}:${p.toolId}`, ...(p.toolLimit ?? { perMinute: d.agentToolPerMinute, burst: d.agentToolBurst }) },
    ];
    const global = p.serverPerToolPerMinute ?? d.toolGlobalPerMinute;
    if (global) checks.push({ scope: 'tool', key: `tool:${p.toolId}`, perMinute: global, burst: global });
    return checks;
  }

  async take(checks: readonly LimitCheck[]): Promise<LimitResult> {
    for (const c of checks) {
      const cfg = perMinute(c.perMinute, c.burst);
      const r = await this.store.take(c.key, { capacity: cfg.capacity, refillPerMs: cfg.refillPerMs });
      if (!r.allowed) return { allowed: false, scope: c.scope, retryAfterMs: r.retryAfterMs };
    }
    return { allowed: true };
  }
}
