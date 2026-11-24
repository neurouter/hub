import type { ThemePreference } from '@neurouter/shared';

/** localStorage key shared with public/theme-init.js (pre-paint script). */
export const THEME_STORAGE_KEY = 'neurouter-theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

export type Theme = ThemePreference;
export type ResolvedTheme = 'light' | 'dark';

export function parseTheme(value: string | null | undefined): Theme {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

/** Applies the resolved theme to <html> (class + color-scheme), exactly like theme-init.js. */
export function applyTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}
