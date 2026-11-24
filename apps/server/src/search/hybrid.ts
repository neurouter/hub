/** Reciprocal-rank-fusion constant (backend §11.4). */
export const RRF_K = 60;
/** Exact name match boost: always ranks first. */
export const EXACT_MATCH_BOOST = 1;
/** Favorites weight (P2): comparable to one RRF rank step near the top. */
export const FAVORITE_BETA = 0.01;

export interface RankedCandidate {
  id: string;
  /** Tie-break key (exposed name), ascending. */
  name: string;
  score: number;
}

/**
 * Hybrid ranking (backend §11.4, pure): `score(t) = Σ 1/(k + rank)` over the ranked lists
 * (1-based ranks), +1 for an exact name match, + β·fav/(1+fav) when favorites are provided,
 * ties broken by name ascending. Only ids present in `allowed` are ever returned: the ACL is
 * applied before ranking, and this is a second guard.
 */
export function fuseRankings(input: {
  lists: ReadonlyArray<readonly string[]>;
  allowed: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
  exact?: ReadonlySet<string>;
  favorites?: ReadonlyMap<string, number>;
  limit: number;
  k?: number;
}): RankedCandidate[] {
  const k = input.k ?? RRF_K;
  const scores = new Map<string, number>();
  for (const list of input.lists) {
    const seen = new Set<string>();
    let rank = 0;
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      if (!input.allowed.has(id)) continue;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    }
  }
  for (const id of input.exact ?? []) if (input.allowed.has(id)) scores.set(id, (scores.get(id) ?? 0) + EXACT_MATCH_BOOST);
  if (input.favorites) {
    for (const [id, fav] of input.favorites) {
      const s = scores.get(id);
      if (s !== undefined && fav > 0) scores.set(id, s + (FAVORITE_BETA * fav) / (1 + fav));
    }
  }
  const out: RankedCandidate[] = [];
  for (const [id, score] of scores) out.push({ id, name: input.names.get(id) ?? id, score });
  out.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out.slice(0, Math.max(0, input.limit));
}
