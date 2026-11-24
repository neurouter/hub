import { useQuery } from '@tanstack/react-query';
import { api } from '@neurouter/shared';
import { filterLabels } from '@/features/audit/search';
import { apiFetch } from '@/lib/api-client';

/** Ids that still need a display name (not chosen in a picker this session). */
export function missingIds(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((x): x is string => !!x && !filterLabels.has(x)))].sort();
}

/**
 * Resolves display names for id-only filter chips after a reload or a shared link
 * (GET /api/lookup/names). Names land in `filterLabels`, which the chips already read; the
 * returned version changes when they arrive so the caller re-renders. Ids the viewer may not
 * see stay as short ids.
 */
export function useFilterNames(ids: readonly (string | null | undefined)[]): number {
  const missing = missingIds(ids);
  const q = useQuery({
    queryKey: ['lookup', 'names', missing],
    queryFn: async ({ signal }) => {
      const r = await apiFetch(api.system.names, { query: { ids: missing }, signal });
      for (const [id, v] of Object.entries(r.names)) filterLabels.set(id, v.name);
      return r;
    },
    enabled: missing.length > 0,
    staleTime: Infinity,
  });
  return q.dataUpdatedAt;
}
