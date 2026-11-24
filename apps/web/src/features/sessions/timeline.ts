import type { SessionEvent, SessionSource } from '@neurouter/shared';

export const IDLE_GAP_MS = 60_000;

export interface TimelineItem {
  event: SessionEvent;
  /** ms since session start */
  offsetMs: number;
  /** idle time before this call when > 1 min (collapsed separator), else null */
  gapMs: number | null;
  /** latency as % of the session max (latency bar width) */
  latencyPct: number;
}

/** Orders events, computes offsets, idle gaps (> 1 min) and latency bars scaled to the session max (§5.4). */
export function buildTimeline(events: SessionEvent[], startedAt: string): { items: TimelineItem[]; maxLatencyMs: number } {
  const sorted = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const start = Date.parse(startedAt);
  const maxLatencyMs = Math.max(0, ...sorted.map((e) => e.latencyMs ?? 0));
  let prev: number | null = null;
  const items = sorted.map((event) => {
    const t = Date.parse(event.ts);
    const gap = prev !== null && t - prev > IDLE_GAP_MS ? t - prev : null;
    prev = t;
    return { event, offsetMs: Math.max(0, t - start), gapMs: gap, latencyPct: maxLatencyMs ? ((event.latencyMs ?? 0) / maxLatencyMs) * 100 : 0 };
  });
  return { items, maxLatencyMs };
}

export const SOURCE_LABEL: Record<SessionSource, string> = {
  client: 'client id',
  trace: 'trace',
  legacy: 'legacy',
  idle_gap: 'inferred (idle gap)',
};

/** "4 min idle" / "17 min idle" / "2 h 5 min idle" */
export function idleLabel(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min idle`;
  return `${Math.floor(min / 60)} h ${min % 60} min idle`;
}
