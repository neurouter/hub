import { describe, expect, it } from 'vitest';
import { SESSIONS, sessionEvents } from '@/mocks/demo-data';
import { buildTimeline, idleLabel } from './timeline';

describe('session timeline', () => {
  it('computes offsets, collapses idle gaps > 1 min and scales latency to the session max', () => {
    const s = SESSIONS[0]!;
    const { items, maxLatencyMs } = buildTimeline([...sessionEvents(s.id)].reverse(), s.startedAt);
    expect(maxLatencyMs).toBe(4120);
    expect(items[0]!.offsetMs).toBe(0);
    expect(items[0]!.gapMs).toBeNull();
    expect(items[2]!.gapMs).toBeNull(); // 8.1 s after start
    expect(Math.round(items[3]!.gapMs! / 60_000)).toBe(17);
    expect(items.find((i) => i.event.latencyMs === 4120)!.latencyPct).toBe(100);
    expect(items.map((i) => i.offsetMs)).toEqual([...items.map((i) => i.offsetMs)].sort((a, b) => a - b));
  });

  it('labels idle time', () => {
    expect(idleLabel(4 * 60_000)).toBe('4 min idle');
    expect(idleLabel(125 * 60_000)).toBe('2 h 5 min idle');
  });
});
