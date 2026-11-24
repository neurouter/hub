import { useCallback, useMemo, useState } from 'react';
import { clock } from '@/lib/clock';
import { resolveRange, type RangeSearch, type ResolvedRange } from '@/lib/time-range';

/**
 * Resolves the URL range to concrete `{ from, to }` and keeps it STABLE between renders (so query
 * keys don't change every render). It re-anchors at "now" when the range in the URL changes or
 * when `refresh()` is called (manual refresh / auto-refresh tick).
 */
export function useTimeRange(search: RangeSearch, maxDays?: number): ResolvedRange & { refresh: () => void } {
  const key = `${search.range ?? ''}|${search.from ?? ''}|${search.to ?? ''}`;
  const [tick, setTick] = useState(0);
  // re-anchored whenever the URL range or the refresh tick changes
  const now = useMemo(() => (tick >= 0 ? clock.now() : 0), [key, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const resolved = useMemo(() => resolveRange(search, now, maxDays), [search, now, maxDays]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...resolved, refresh };
}
