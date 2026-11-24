import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { renderRoute } from '@/test/render';
import { THEME_STORAGE_KEY } from './theme-core';

describe('theme follows the account (me.updatePreferences)', () => {
  it('adopts the account theme on sign-in without saving it back', async () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    let patched = 0;
    await renderRoute('/settings/appearance', {
      me: { ...meFixture('admin'), preferences: { theme: 'dark' } },
      fixtures: { 'me.updatePreferences': () => (patched++, { preferences: { theme: 'dark' } }) },
    });
    await waitFor(() => expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark'));
    expect(screen.getByRole('radio', { name: /dark/i })).toBeChecked();
    expect(patched).toBe(0);
  });

  it('saves a theme change to the account', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    let body: unknown;
    const { user } = await renderRoute('/settings/appearance', {
      fixtures: { 'me.updatePreferences': async ({ request }: { request: Request }) => ((body = await request.json()), { preferences: body as { theme: 'dark' } }) },
    });
    await user.click(await screen.findByRole('radio', { name: /dark/i }));
    await waitFor(() => expect(body).toEqual({ theme: 'dark' }));
  });

  it('keeps the local theme when the account has none', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    let patched = 0;
    await renderRoute('/settings/appearance', { fixtures: { 'me.updatePreferences': () => (patched++, { preferences: {} }) } });
    expect(await screen.findByRole('radio', { name: /light/i })).toBeChecked();
    expect(patched).toBe(0);
  });
});
