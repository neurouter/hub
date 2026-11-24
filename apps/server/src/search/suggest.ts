/**
 * "Did you mean" for catalog tool search (frontend plan W8): when a query finds nothing, each
 * query word that is not in the vocabulary of the tools the viewer may see is replaced by the
 * closest vocabulary word within a small edit distance. Pure and deterministic; no index needed.
 */

const WORD = /[\p{L}\p{N}]+/gu;
const MIN_LEN = 3;

/** Lower-cased words of a text; `snake_case`, `kebab-case`, `__` and camelCase are split. */
export function words(text: string): string[] {
  const split = text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2');
  return (split.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= MIN_LEN);
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions), capped at `max + 1`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array<number>(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j]!;
    prev = cur;
  }
  return Math.min(prev[b.length]!, max + 1);
}

/** Allowed typos for a word of this length: 1 up to 5 letters, 2 above. */
const budget = (len: number) => (len <= 5 ? 1 : 2);

/**
 * Builds the corrected query, or null when every word is already known or nothing is close.
 * Ties prefer the more frequent vocabulary word, then the alphabetically first.
 */
export function suggestQuery(query: string, texts: Iterable<string>): string | null {
  const freq = new Map<string, number>();
  for (const t of texts) for (const w of words(t)) freq.set(w, (freq.get(w) ?? 0) + 1);
  if (!freq.size) return null;
  const vocab = [...freq.keys()].sort();
  const tokens = query.toLowerCase().match(WORD) ?? [];
  let changed = false;
  const out = tokens.map((tok) => {
    if (tok.length < MIN_LEN || freq.has(tok)) return tok;
    const max = budget(tok.length);
    let best: { w: string; d: number; f: number } | null = null;
    for (const w of vocab) {
      const d = editDistance(tok, w, max);
      if (d > max) continue;
      const f = freq.get(w)!;
      if (!best || d < best.d || (d === best.d && f > best.f)) best = { w, d, f };
    }
    if (!best) return tok;
    changed = true;
    return best.w;
  });
  return changed ? out.join(' ') : null;
}
