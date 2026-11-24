import { describe, expect, it } from 'vitest';
import {
  DASH, formatBytes, formatCompact, formatDate, formatDateTime, formatDuration, formatNumber, formatOffset, formatPercent, formatRelative, formatTime,
  middleEllipsis, plural, shortHash,
} from './format';

describe('format', () => {
  it('formats numbers, compact numbers and percents', () => {
    expect(formatNumber(184302)).toBe('184,302');
    expect(formatNumber(null)).toBe(DASH);
    expect(formatCompact(2400)).toBe('2.4K');
    expect(formatPercent(0.9871)).toBe('98.71%');
    expect(formatPercent(0.992, 1)).toBe('99.2%');
    expect(formatPercent(null)).toBe(DASH);
  });

  it('formats durations like the prototype latency column', () => {
    expect(formatDuration(842)).toBe('842 ms');
    expect(formatDuration(1920)).toBe('1.92 s');
    expect(formatDuration(30_000)).toBe('30.0 s');
    expect(formatDuration(41_000)).toBe('41.0 s');
    expect(formatDuration(300_000)).toBe('5 m 00 s');
    expect(formatDuration(2 * 3600_000 + 5 * 60_000)).toBe('2 h 05 m');
    expect(formatDuration(undefined)).toBe(DASH);
  });

  it('formats session offsets', () => {
    expect(formatOffset(0)).toBe('+0.0 s');
    expect(formatOffset(8100)).toBe('+8.1 s');
    expect(formatOffset(17 * 60_000 + 33_000)).toBe('+17 m 33 s');
  });

  it('formats bytes (1024 base)', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(18_841)).toBe('18.4 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('formats dates in UTC when asked', () => {
    const iso = '2026-11-23T14:22:18.402Z';
    expect(formatDate(iso, { utc: true })).toBe('Nov 23, 2026');
    expect(formatTime(iso, { utc: true })).toBe('14:22:18');
    expect(formatDateTime(iso, { utc: true })).toBe('Nov 23, 2026 14:22:18');
    expect(formatDate(null)).toBe(DASH);
  });

  it('formats relative times in the past and future', () => {
    const now = Date.parse('2026-11-24T10:00:00Z');
    expect(formatRelative('2026-11-24T09:59:58Z', now)).toBe('just now');
    expect(formatRelative('2026-11-24T09:59:48Z', now)).toBe('12 s ago');
    expect(formatRelative('2026-11-24T09:57:00Z', now)).toBe('3 min ago');
    expect(formatRelative('2026-11-24T01:00:00Z', now)).toBe('9 h ago');
    expect(formatRelative('2026-11-22T09:00:00Z', now)).toBe('2 days ago');
    expect(formatRelative('2026-11-27T10:00:00Z', now)).toBe('in 3 days');
    expect(formatRelative(null, now)).toBe('Never');
  });

  it('shortens ids and hashes', () => {
    expect(middleEllipsis('0193a000-0000-7000-8000-000000000001')).toBe('0193a000…000001');
    expect(middleEllipsis('short')).toBe('short');
    expect(shortHash('sha256:3f9a1c7d2be04a61c8f0e95d7712aa04b0c1d2e3f4a5b6c7d8e9f00112c21e')).toBe('sha256:3f9a1c…c21e');
    expect(plural(1, 'change')).toBe('1 change');
    expect(plural(3, 'change')).toBe('3 changes');
  });
});
