/**
 * Display formatting (frontend §6.5, §7): numbers, percents, durations, bytes and dates.
 * Locale is fixed to en-US so tables and tests are deterministic; the time zone is either the
 * browser's (default) or UTC, per call or from the viewer's time display preference.
 */

import { prefersUtc } from './display-prefs';

const LOCALE = 'en-US';
export const DASH = '—';

export interface TimeOpts {
  /** Render in UTC instead of the browser time zone. Unset: the viewer's Appearance preference. */
  utc?: boolean;
}

const nf = new Intl.NumberFormat(LOCALE);
const compact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });

export function formatNumber(n: number | null | undefined): string {
  return n === null || n === undefined || Number.isNaN(n) ? DASH : nf.format(n);
}

/** 1,234 → "1.2K" */
export function formatCompact(n: number | null | undefined): string {
  return n === null || n === undefined || Number.isNaN(n) ? DASH : compact.format(n);
}

/** Rate in 0..1 → "98.71%". */
export function formatPercent(rate: number | null | undefined, digits = 2): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return DASH;
  return `${(rate * 100).toFixed(digits)}%`;
}

/**
 * Milliseconds → "842 ms", "1.38 s", "41.0 s", "5 m 00 s", "2 h 05 m".
 * Matches the prototype's latency columns.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return DASH;
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)} ms`;
  if (abs < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const totalSec = Math.round(abs / 1000);
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m} m ${String(s).padStart(2, '0')} s`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h} h ${String(m).padStart(2, '0')} m`;
}

/** Offset from a session start: "+0.0 s", "+8.1 s", "+17 m 33 s". */
export function formatOffset(ms: number): string {
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  return `+${formatDuration(ms)}`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
/** 18_841 → "18.4 KB" (1 KB = 1024 B). */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return DASH;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${BYTE_UNITS[i]}`;
}

function dtf(opts: Intl.DateTimeFormatOptions, t: TimeOpts) {
  return new Intl.DateTimeFormat(LOCALE, { ...opts, ...((t.utc ?? prefersUtc()) ? { timeZone: 'UTC' } : {}) });
}

function toDate(v: string | number | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

/** "Nov 23, 2026" */
export function formatDate(v: string | number | Date | null | undefined, t: TimeOpts = {}): string {
  if (v === null || v === undefined) return DASH;
  return dtf({ month: 'short', day: '2-digit', year: 'numeric' }, t).format(toDate(v));
}

/** "14:22:18" (24 h) */
export function formatTime(v: string | number | Date | null | undefined, t: TimeOpts = {}): string {
  if (v === null || v === undefined) return DASH;
  return dtf({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }, t).format(toDate(v));
}

/** "14:22" (24 h) */
export function formatHourMinute(v: string | number | Date, t: TimeOpts = {}): string {
  return dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, t).format(toDate(v));
}

/** "Nov 23, 2026 14:22:18" */
export function formatDateTime(v: string | number | Date | null | undefined, t: TimeOpts = {}): string {
  if (v === null || v === undefined) return DASH;
  return `${formatDate(v, t)} ${formatTime(v, t)}`;
}

/** Relative time: "just now", "12 s ago", "3 min ago", "9 h ago", "2 days ago"; future: "in 3 days". */
export function formatRelative(v: string | number | Date | null | undefined, now: number = Date.now(), never = 'Never'): string {
  if (v === null || v === undefined) return never;
  const diff = now - toDate(v).getTime();
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  let text: string;
  if (s < 5) return 'just now';
  if (s < 60) text = `${Math.floor(s)} s`;
  else if (s < 3600) text = `${Math.floor(s / 60)} min`;
  else if (s < 86_400) text = `${Math.floor(s / 3600)} h`;
  else {
    const d = Math.floor(s / 86_400);
    text = `${d} ${d === 1 ? 'day' : 'days'}`;
  }
  return future ? `in ${text}` : `${text} ago`;
}

/** "abcdef0123…89ab" for long ids and hashes (monospace, copyable). */
export function middleEllipsis(s: string | null | undefined, head = 8, tail = 6): string {
  if (!s) return DASH;
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** "sha256:3f9a1c…c21e" */
export function shortHash(h: string | null | undefined): string {
  if (!h) return DASH;
  const [algo, value] = h.includes(':') ? (h.split(':', 2) as [string, string]) : ['sha256', h];
  return `${algo}:${value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value}`;
}

/** "1 change" / "3 changes" */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
