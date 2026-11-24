// Smoke (traces: 16-theme, 02-sidebar): main pages render in light and dark without errors.
import { type Page } from '@playwright/test';
import { ADMIN_EMAIL, uid } from './support/api';
import { expect, signIn, test } from './support/fixtures';

const PAGES: [string, string][] = [
  ['/catalog', 'Catalog'],
  ['/agents', 'My agents'],
  ['/connect', 'Connect a client'],
  ['/admin/servers', 'Servers'],
  ['/admin/tools', 'Tools'],
  ['/admin/approvals', 'Approvals'],
  ['/admin/access-control', 'Access control'],
  ['/audit', 'Audit log'],
  ['/observability', 'Overview'],
  ['/observability/sessions', 'Sessions'],
  ['/admin/settings', 'Gateway settings'],
];

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test(`main pages render in ${scheme} mode without errors`, async ({ page }) => {
      const errors = collectErrors(page);
      await signIn(page, ADMIN_EMAIL);
      for (const [path, title] of PAGES) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
        if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/);
        else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        expect(bg, `${path} background`).toBe(scheme === 'dark' ? 'rgb(10, 10, 10)' : 'rgb(255, 255, 255)');
      }
      expect(errors).toEqual([]);
    });
  });
}

test('the theme menu switches and remembers the theme for the account', async ({ page }) => {
  await signIn(page, `user-${uid()}@e2e.test`);
  await page.goto('/catalog');
  await page.getByRole('button', { name: /^Theme: system/ }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Theme: dark' })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.getByRole('button', { name: 'Theme: dark' }).click();
  await page.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
});
