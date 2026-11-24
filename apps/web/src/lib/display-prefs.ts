import { useSyncExternalStore } from 'react';
import { readStorage, writeStorage } from './storage';

/**
 * Per-device display preferences (frontend §5.5, `/settings/appearance`): time display and table
 * density. Stored in localStorage (never throws); density is mirrored to `<html data-density>` so
 * tables restyle through CSS without re-rendering.
 */
export type TimeDisplay = 'local' | 'utc';
export type Density = 'comfortable' | 'compact';
export interface DisplayPrefs {
  timeDisplay: TimeDisplay;
  density: Density;
}

export const DISPLAY_PREFS_KEY = 'neurouter-display';
const DEFAULTS: DisplayPrefs = { timeDisplay: 'local', density: 'comfortable' };

export function parseDisplayPrefs(raw: string | null): DisplayPrefs {
  if (!raw) return DEFAULTS;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof DisplayPrefs, unknown>>;
    return {
      timeDisplay: v.timeDisplay === 'utc' ? 'utc' : 'local',
      density: v.density === 'compact' ? 'compact' : 'comfortable',
    };
  } catch {
    return DEFAULTS;
  }
}

let current: DisplayPrefs | null = null;
const listeners = new Set<() => void>();

function applyDensity(d: Density): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.density = d;
}

export function getDisplayPrefs(): DisplayPrefs {
  if (!current) {
    current = parseDisplayPrefs(typeof window === 'undefined' ? null : readStorage(DISPLAY_PREFS_KEY));
    applyDensity(current.density);
  }
  return current;
}

export function setDisplayPrefs(patch: Partial<DisplayPrefs>): void {
  current = { ...getDisplayPrefs(), ...patch };
  writeStorage(DISPLAY_PREFS_KEY, JSON.stringify(current));
  applyDensity(current.density);
  for (const l of listeners) l();
}

/** Re-reads storage (tests, and the `storage` event from another tab). */
export function reloadDisplayPrefs(): void {
  current = null;
  getDisplayPrefs();
  for (const l of listeners) l();
}

function onStorage(e: StorageEvent): void {
  if (e.key === DISPLAY_PREFS_KEY) reloadDisplayPrefs();
}

function subscribe(l: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function useDisplayPrefs(): DisplayPrefs {
  return useSyncExternalStore(subscribe, getDisplayPrefs, getDisplayPrefs);
}

/** Whether dates render in UTC when a caller doesn't say. */
export function prefersUtc(): boolean {
  return getDisplayPrefs().timeDisplay === 'utc';
}
