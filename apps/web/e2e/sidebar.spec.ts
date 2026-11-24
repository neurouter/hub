// Flow 02 (traces: 02-sidebar): the sidebar adapts to the role; admin areas are guarded for users.
import { ADMIN_EMAIL, uid } from './support/api';
import { expect, signIn, test } from './support/fixtures';

const PORTAL = ['Catalog', 'My agents', 'Connections', 'Connect a client', 'My activity', 'My requests'];
const ADMIN_ONLY = ['Approvals', 'Access requests', 'Users', 'Groups', 'Agents', 'Servers', 'Tools', 'Access control', 'Overview', 'Sessions', 'Audit log', 'Gateway settings'];

test('a plain user sees only the portal', async ({ page }) => {
  await signIn(page, `user-${uid()}@e2e.test`);
  await page.goto('/catalog');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  for (const name of PORTAL) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  for (const name of ADMIN_ONLY) await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  await expect(nav.getByText('Administration')).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Catalog', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('a plain user gets "Access denied" on admin pages', async ({ page }) => {
  await signIn(page, `user-${uid()}@e2e.test`);
  for (const path of ['/admin/servers', '/admin/approvals', '/audit', '/observability', '/admin/settings']) {
    await page.goto(path);
    await expect(page.getByText('Access denied')).toBeVisible();
    await expect(page.getByText("You don't have access to this page.")).toBeVisible();
  }
});

test('the admin sees every group and the active item follows the route', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL);
  await page.goto('/admin/servers');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  for (const group of ['Portal', 'Review', 'Administration', 'Audit & observability', 'Settings']) await expect(nav.getByText(group, { exact: true })).toBeVisible();
  for (const name of [...PORTAL, ...ADMIN_ONLY]) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Servers', exact: true })).toHaveAttribute('aria-current', 'page');

  await nav.getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(page).toHaveURL(/\/observability\/sessions$/);
  // longest matching prefix wins: Sessions, not Overview
  await expect(nav.getByRole('link', { name: 'Sessions', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Overview', exact: true })).not.toHaveAttribute('aria-current', 'page');

  // collapse to icons and expand again with the header toggle
  const catalog = nav.getByRole('link', { name: 'Catalog', exact: true });
  const width = async () => (await catalog.boundingBox())?.width ?? 0;
  await page.getByRole('button', { name: 'Toggle sidebar (Ctrl+B)' }).click();
  await expect.poll(width).toBeLessThan(48);
  await page.getByRole('button', { name: 'Toggle sidebar (Ctrl+B)' }).click();
  await expect.poll(width).toBeGreaterThan(150);
});
