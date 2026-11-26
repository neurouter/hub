// Flow 01 (traces: .agent/reports/e2e-traces/01-sign-in): dev login, returnTo, sign out, guarded routes.
import { ADMIN_EMAIL, uid } from './support/api';
import { expect, test } from './support/fixtures';

test.describe('sign-in and sign-out', () => {
  test('an unauthenticated deep link goes to login, then back to the page after signing in', async ({ page }) => {
    await page.goto('/agents');
    await expect(page).toHaveURL(/\/auth\/login\?returnTo=%2Fagents$/);
    await expect(page.getByText('Sign in to Neurouter Hub')).toBeVisible();
    await page.getByLabel('Development login').fill(`user-${uid()}@e2e.test`);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole('heading', { level: 1, name: 'My agents' })).toBeVisible();
  });

  test('the admin lands on the overview and signs out from the user menu', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Development login').fill(ADMIN_EMAIL);
    await page.getByLabel('Development login').press('Enter');
    await expect(page).toHaveURL(/\/observability$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

    await page.getByRole('button', { name: 'Open user menu' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Profile' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/auth\/logged-out$/);
    await expect(page.getByText("You're signed out")).toBeVisible();

    // the session is gone: protected pages send you back to login
    await page.goto('/admin/servers');
    await expect(page).toHaveURL(/\/auth\/login\?returnTo=%2Fadmin%2Fservers$/);
    await page.goto('/auth/logged-out');
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page.getByLabel('Development login')).toBeVisible();
  });

  test('the login form requires an email', async ({ page }) => {
    await page.goto('/auth/login');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/auth\/login/);
    expect(await page.getByLabel('Development login').evaluate((e: HTMLInputElement) => e.validity.valueMissing)).toBe(true);
  });
});
