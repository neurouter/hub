import { describe, expect, it } from 'vitest';
import { pickInterval, previousLabel, rangeLabel, rangeSearchSchema, resolveRange } from './time-range';

const NOW = Date.parse('2026-11-24T10:00:00.000Z');
const H = 3600_000;

describe('time ranges', () => {
  it('defaults to the last 24 hours', () => {
    const r = resolveRange({}, NOW);
    expect(r.key).toBe('24h');
    expect(r.to).toBe('2026-11-24T10:00:00.000Z');
    expect(r.from).toBe('2026-11-23T10:00:00.000Z');
  });

  it('resolves presets anchored at now', () => {
    expect(resolveRange({ range: '1h' }, NOW).from).toBe('2026-11-24T09:00:00.000Z');
    expect(resolveRange({ range: '7d' }, NOW).from).toBe('2026-11-17T10:00:00.000Z');
  });

  it('accepts a valid custom range and clamps it to 31 days', () => {
    const r = resolveRange({ range: 'custom', from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' }, NOW);
    expect(r).toMatchObject({ key: 'custom', from: '2026-11-20T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' });
    const long = resolveRange({ range: 'custom', from: '2026-01-01T00:00:00Z', to: '2026-11-21T00:00:00Z' }, NOW);
    expect(long.toMs - long.fromMs).toBe(31 * 24 * H);
  });

  it('falls back to 24h when the custom range is invalid or inverted', () => {
    expect(resolveRange({ range: 'custom', from: '2026-11-21T00:00:00Z', to: '2026-11-20T00:00:00Z' }, NOW).key).toBe('24h');
    expect(resolveRange({ range: 'custom' }, NOW).key).toBe('24h');
  });

  it('drops invalid URL values instead of throwing', () => {
    expect(rangeSearchSchema.parse({ range: 'forever', from: 'yesterday', to: 42 })).toEqual({ range: undefined, from: undefined, to: undefined });
    expect(rangeSearchSchema.parse({ range: '7d' })).toEqual({ range: '7d' });
  });

  it('picks chart intervals per range', () => {
    expect(pickInterval(0, H)).toBe('1m');
    expect(pickInterval(0, 6 * H)).toBe('5m');
    expect(pickInterval(0, 24 * H)).toBe('15m');
    expect(pickInterval(0, 7 * 24 * H)).toBe('1h');
    expect(pickInterval(0, 30 * 24 * H)).toBe('6h');
    expect(pickInterval(0, 90 * 24 * H)).toBe('1d');
  });

  it('labels ranges', () => {
    expect(rangeLabel(resolveRange({ range: '24h' }, NOW))).toBe('Last 24 hours');
    expect(rangeLabel({ key: 'custom', from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' })).toMatch(/→/);
    expect(previousLabel({ key: '24h' })).toBe('vs previous 24h');
    expect(previousLabel({ key: 'custom' })).toBe('vs previous period');
  });
});
