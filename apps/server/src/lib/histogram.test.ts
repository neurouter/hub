import { describe, expect, it } from 'vitest';
import { bucketIndex, bucketWidthAt, emptyHistogram, HISTOGRAM_KEYS, histogramOf, LATENCY_BUCKETS_MS, percentile } from './histogram.js';

function exact(samples: number[], p: number): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
}

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('latency histogram', () => {
  it('has 20 buckets h00..h19 with an open last bucket', () => {
    expect(LATENCY_BUCKETS_MS).toHaveLength(20);
    expect(HISTOGRAM_KEYS[0]).toBe('h00');
    expect(HISTOGRAM_KEYS[19]).toBe('h19');
    expect(LATENCY_BUCKETS_MS[19]).toBe(Number.POSITIVE_INFINITY);
  });

  it('assigns latencies to buckets with inclusive upper bounds', () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(5)).toBe(0);
    expect(bucketIndex(5.1)).toBe(1);
    expect(bucketIndex(1000)).toBe(10);
    expect(bucketIndex(60_001)).toBe(19);
    expect(bucketIndex(-3)).toBe(0);
  });

  it('returns null without samples and reads rollup rows', () => {
    expect(percentile(emptyHistogram(), 0.5)).toBeNull();
    const row = Object.fromEntries(HISTOGRAM_KEYS.map((k, i) => [k, i]));
    expect(histogramOf(row)[19]).toBe(19);
  });

  it.each([
    ['uniform 0-2000ms', (r: () => number) => r() * 2000],
    ['log-normal-ish', (r: () => number) => Math.exp(3 + r() * 5)],
    ['bimodal', (r: () => number) => (r() < 0.8 ? 20 + r() * 30 : 800 + r() * 3000)],
  ])('percentiles of %s are within one bucket width of the exact value', (_name, gen) => {
    const r = rng(42);
    const samples = Array.from({ length: 5000 }, () => gen(r));
    const h = emptyHistogram();
    for (const s of samples) h[bucketIndex(s)]!++;
    const max = Math.max(...samples);
    for (const p of [0.5, 0.95, 0.99]) {
      const est = percentile(h, p, max)!;
      const ex = exact(samples, p);
      expect(Math.abs(est - ex)).toBeLessThanOrEqual(bucketWidthAt(ex));
    }
  });

  it('caps the open-ended bucket at the observed max', () => {
    const h = emptyHistogram();
    h[19] = 10;
    expect(percentile(h, 0.99, 90_000)).toBeLessThanOrEqual(90_000);
    expect(percentile(h, 0.5, 90_000)).toBeGreaterThanOrEqual(60_000);
  });
});
