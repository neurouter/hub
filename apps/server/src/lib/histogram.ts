/**
 * Fixed log-scale latency histogram (backend §10.1). The same 20 upper bounds (ms) back the
 * rollup columns `h00..h19` and the Prometheus histograms, so percentiles computed from rollups
 * and from /metrics agree.
 *
 * Percentiles are estimated by summing bucket counts over the queried range and interpolating
 * linearly inside the target bucket. The error is bounded by the width of the bucket that holds
 * the percentile (documented max error: one bucket width; for the open-ended last bucket the
 * estimate is clamped to the observed max latency).
 */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 75, 100, 150, 250, 400, 600, 1000, 1500, 2500, 4000, 6000, 10000, 15000, 30000, 60000, Number.POSITIVE_INFINITY] as const;
export const HISTOGRAM_SIZE = LATENCY_BUCKETS_MS.length;
export const HISTOGRAM_KEYS = Array.from({ length: HISTOGRAM_SIZE }, (_, i) => `h${String(i).padStart(2, '0')}`) as readonly HistogramKey[];
export type HistogramKey = `h${string}`;

/** Index of the bucket a latency falls in (upper bound inclusive). */
export function bucketIndex(latencyMs: number): number {
  const v = Math.max(0, latencyMs);
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) if (v <= LATENCY_BUCKETS_MS[i]!) return i;
  return LATENCY_BUCKETS_MS.length - 1;
}

export function emptyHistogram(): number[] {
  return new Array<number>(HISTOGRAM_SIZE).fill(0);
}

export function addHistograms(a: number[], b: readonly number[]): number[] {
  for (let i = 0; i < HISTOGRAM_SIZE; i++) a[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return a;
}

/** Reads `h00..h19` from a rollup row into an array. */
export function histogramOf(row: Record<string, unknown>): number[] {
  return HISTOGRAM_KEYS.map((k) => Number(row[k] ?? 0));
}

/**
 * Percentile (0 < p ≤ 1) from bucket counts. Returns null when there are no samples.
 * `maxObserved` caps the estimate (and stands in for the +Inf bucket's upper bound).
 */
export function percentile(counts: readonly number[], p: number, maxObserved?: number | null): number | null {
  const total = counts.reduce((s, c) => s + c, 0);
  if (total <= 0) return null;
  const rank = Math.max(1, Math.ceil(p * total));
  let cum = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] ?? 0;
    if (c <= 0) continue;
    if (cum + c >= rank) {
      const lower = i === 0 ? 0 : LATENCY_BUCKETS_MS[i - 1]!;
      let upper: number = LATENCY_BUCKETS_MS[i]!;
      if (!Number.isFinite(upper)) upper = Math.max(lower, maxObserved ?? lower);
      const frac = (rank - cum) / c;
      let v = lower + (upper - lower) * frac;
      if (maxObserved !== undefined && maxObserved !== null && maxObserved > 0) v = Math.min(v, maxObserved);
      return Math.round(v * 100) / 100;
    }
    cum += c;
  }
  return null;
}

/** Width of the bucket that contains `value` (the documented maximum estimation error). */
export function bucketWidthAt(value: number): number {
  const i = bucketIndex(value);
  const lower = i === 0 ? 0 : LATENCY_BUCKETS_MS[i - 1]!;
  const upper = LATENCY_BUCKETS_MS[i]!;
  return Number.isFinite(upper) ? upper - lower : Number.POSITIVE_INFINITY;
}
