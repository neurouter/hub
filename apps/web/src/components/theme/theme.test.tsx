import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMedia } from '@/test/setup';
import { DARK_QUERY, THEME_STORAGE_KEY, parseTheme, resolveTheme } from './theme-core';
import { ThemeProvider, useTheme } from './theme-provider';
import { ThemeToggle } from './theme-toggle';

const INIT_SCRIPT = readFileSync(resolve(import.meta.dirname, '../../../public/theme-init.js'), 'utf8');
const runInitScript = () => new Function(INIT_SCRIPT)();
const html = () => document.documentElement;

afterEach(() => vi.restoreAllMocks());

describe('public/theme-init.js (pre-paint)', () => {
  it.each([
    ['dark', false, true],
    ['light', true, false],
    ['system', true, true],
    ['system', false, false],
    [null, true, true],
    ['garbage', false, false],
  ])('stored=%s systemDark=%s → dark=%s', (stored, systemDark, dark) => {
    if (stored) localStorage.setItem(THEME_STORAGE_KEY, stored);
    setMedia(DARK_QUERY, systemDark);
    runInitScript();
    expect(html().classList.contains('dark')).toBe(dark);
    expect(html().style.colorScheme).toBe(dark ? 'dark' : 'light');
  });

  it('falls back to the system theme when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    setMedia(DARK_QUERY, true);
    expect(runInitScript).not.toThrow();
    expect(html().classList.contains('dark')).toBe(true);
  });

  it('agrees with theme-core for every stored value', () => {
    for (const stored of ['light', 'dark', 'system', 'x']) {
      for (const sys of [true, false]) {
        localStorage.setItem(THEME_STORAGE_KEY, stored);
        setMedia(DARK_QUERY, sys);
        runInitScript();
        expect(html().classList.contains('dark')).toBe(resolveTheme(parseTheme(stored), sys) === 'dark');
      }
    }
  });
});

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setTheme('dark')}>dark</button>
      <button onClick={() => setTheme('system')}>system</button>
    </div>
  );
}

describe('ThemeProvider', () => {
  it('defaults to system and follows OS changes live', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(html().classList.contains('dark')).toBe(false);
    act(() => setMedia(DARK_QUERY, true));
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(html().classList.contains('dark')).toBe(true);
  });

  it('persists the choice and applies the class', async () => {
    const user = userEvent.setup();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    await user.click(screen.getByText('dark'));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(html().classList.contains('dark')).toBe(true);
    expect(html().style.colorScheme).toBe('dark');
  });

  it('reads the stored theme and survives storage that throws', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const { unmount } = render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const user = userEvent.setup();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    await user.click(screen.getByText('dark'));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
  });

  it('top-bar toggle offers light / dark / system', async () => {
    const user = userEvent.setup();
    render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
    await user.click(screen.getByRole('button', { name: /theme: system/i }));
    await user.click(await screen.findByRole('menuitemradio', { name: /dark/i }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(html().classList.contains('dark')).toBe(true);
  });
});
