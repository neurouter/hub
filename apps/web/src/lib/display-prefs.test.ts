import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISPLAY_PREFS_KEY, getDisplayPrefs, parseDisplayPrefs, reloadDisplayPrefs, setDisplayPrefs, useDisplayPrefs } from './display-prefs';
import { formatDateTime, formatTime } from './format';

const INIT_SCRIPT = readFileSync(resolve(import.meta.dirname, '../../public/theme-init.js'), 'utf8');

afterEach(() => vi.restoreAllMocks());

describe('display preferences', () => {
  it('parses stored values defensively', () => {
    expect(parseDisplayPrefs(null)).toEqual({ timeDisplay: 'local', density: 'comfortable' });
    expect(parseDisplayPrefs('{bad')).toEqual({ timeDisplay: 'local', density: 'comfortable' });
    expect(parseDisplayPrefs('{"timeDisplay":"utc","density":"compact"}')).toEqual({ timeDisplay: 'utc', density: 'compact' });
    expect(parseDisplayPrefs('{"timeDisplay":"mars","density":7}')).toEqual({ timeDisplay: 'local', density: 'comfortable' });
  });

  it('persists, mirrors density to <html data-density> and notifies subscribers', () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.density).toBe('comfortable');
    act(() => setDisplayPrefs({ density: 'compact' }));
    expect(result.current).toEqual({ timeDisplay: 'local', density: 'compact' });
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_KEY)!)).toEqual({ timeDisplay: 'local', density: 'compact' });
  });

  it('works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    reloadDisplayPrefs();
    expect(getDisplayPrefs().timeDisplay).toBe('local');
    expect(() => setDisplayPrefs({ timeDisplay: 'utc' })).not.toThrow();
    expect(getDisplayPrefs().timeDisplay).toBe('utc');
  });

  it('dates follow the time display preference unless a call says otherwise', () => {
    const ts = '2026-11-23T14:22:18Z';
    setDisplayPrefs({ timeDisplay: 'utc' });
    expect(formatTime(ts)).toBe('14:22:18');
    expect(formatDateTime(ts)).toBe('Nov 23, 2026 14:22:18');
    expect(formatTime(ts, { utc: false })).toBe(new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ts)));
  });

  it('picks up changes made in another tab (storage event)', () => {
    const { result } = renderHook(() => useDisplayPrefs());
    localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify({ timeDisplay: 'utc', density: 'compact' }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: DISPLAY_PREFS_KEY }));
    });
    expect(result.current).toEqual({ timeDisplay: 'utc', density: 'compact' });
  });

  it('the pre-paint script applies the stored density', () => {
    localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify({ density: 'compact' }));
    new Function(INIT_SCRIPT)();
    expect(document.documentElement.dataset.density).toBe('compact');
    localStorage.setItem(DISPLAY_PREFS_KEY, 'garbage');
    new Function(INIT_SCRIPT)();
    expect(document.documentElement.dataset.density).toBe('comfortable');
  });
});
