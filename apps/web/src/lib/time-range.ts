import * as z from 'zod';
import { DEFAULT_AUDIT_MAX_RANGE_DAYS, type MetricsInterval } from '@neurouter/shared';

/**
 * Time ranges for audit, observability and sessions (frontend §5.3/§5.4, addendum 8):
 * presets ↔ { from, to }, URL (de)serialization and chart interval selection.
 */

export const RANGE_PRESETS = ['15m', '1h', '6h', '24h', '7d', '30d'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export type RangeKey = RangePreset | 'custom';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const PRESET_MS: Record<RangePreset, number> = {
  '15m': 15 * MINUTE,
  '1h': HOUR,
  '6h': 6 * HOUR,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
};

export const PRESET_LABEL: Record<RangeKey, string> = {
  '15m': 'Last 15 minutes',
  '1h': 'Last hour',
  '6h': 'Last 6 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  custom: 'Custom range',
};

export const DEFAULT_RANGE: RangePreset = '24h';

const isoOrUndefined = z.iso.datetime({ offset: true }).optional().catch(undefined);

/** URL search fragment shared by every time-ranged page. Invalid values are dropped, never thrown. */
export const rangeSearchSchema = z.object({
  range: z.enum([...RANGE_PRESETS, 'custom']).optional().catch(undefined),
  from: isoOrUndefined,
  to: isoOrUndefined,
});
export type RangeSearch = z.infer<typeof rangeSearchSchema>;

export interface ResolvedRange {
  key: RangeKey;
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
}

/**
 * Turns the URL fragment into a concrete, bounded `{ from, to }` (ISO, UTC).
 * - presets are anchored at `now`
 * - a custom range needs valid from < to; it is clamped to `maxDays`
 * - anything invalid falls back to the default preset (24 h)
 */
export function resolveRange(search: RangeSearch, now: number = Date.now(), maxDays: number = DEFAULT_AUDIT_MAX_RANGE_DAYS): ResolvedRange {
  const key: RangeKey = search.range ?? (search.from && search.to ? 'custom' : DEFAULT_RANGE);
  if (key === 'custom' && search.from && search.to) {
    const f = Date.parse(search.from);
    const t = Date.parse(search.to);
    if (!Number.isNaN(f) && !Number.isNaN(t) && t > f) {
      const fromMs = Math.max(f, t - maxDays * DAY);
      return { key, from: new Date(fromMs).toISOString(), to: new Date(t).toISOString(), fromMs, toMs: t };
    }
  }
  const preset: RangePreset = key === 'custom' ? DEFAULT_RANGE : key;
  const span = Math.min(PRESET_MS[preset], maxDays * DAY);
  const toMs = now;
  const fromMs = now - span;
  return { key: preset, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), fromMs, toMs };
}

/**
 * Chart bucket size for a range (unit-tested; the backend may override and returns the
 * effective interval): 1 h → 1 m, 6 h → 5 m, 24 h → 15 m, 7 d → 1 h, 30 d → 6 h.
 */
export function pickInterval(fromMs: number, toMs: number): MetricsInterval {
  const span = toMs - fromMs;
  if (span <= 2 * HOUR) return '1m';
  if (span <= 12 * HOUR) return '5m';
  if (span <= 2 * DAY) return '15m';
  if (span <= 8 * DAY) return '1h';
  if (span <= 31 * DAY) return '6h';
  return '1d';
}

export const INTERVAL_MS: Record<MetricsInterval, number> = {
  '1m': MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '1h': HOUR,
  '6h': 6 * HOUR,
  '1d': DAY,
};

/** Human label for the active range ("Last 24 hours" or "Nov 20 → Nov 23"). */
export function rangeLabel(r: Pick<ResolvedRange, 'key' | 'from' | 'to'>): string {
  if (r.key !== 'custom') return PRESET_LABEL[r.key];
  const f = new Date(r.from);
  const t = new Date(r.to);
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${fmt.format(f)} → ${fmt.format(t)}`;
}

/** "vs previous 24h" for KPI deltas. */
export function previousLabel(r: Pick<ResolvedRange, 'key'>): string {
  return r.key === 'custom' ? 'vs previous period' : `vs previous ${r.key}`;
}
