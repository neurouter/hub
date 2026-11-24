// Flows 03 + 04 (traces: 03-catalog, 04-server-detail-request-access): catalog search and filters,
// server detail, request access, and the admin approving it.
import { ADMIN_EMAIL, uid } from './support/api';
import { expect, signIn, test } from './support/fixtures';
import { seedServer } from './support/seed';

test('search, Servers/Tools views and the access filter', async ({ page, admin }) => {
  const srv = await seedServer(admin);
  await signIn(page, `user-${uid()}@e2e.test`);
  await page.goto('/catalog');
  await expect(page.getByRole('heading', { level: 1, name: 'Catalog' })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search servers and tools' }).fill(srv.name);
  await expect(page).toHaveURL(/[?&]q=/);
  const card = page.getByRole('article', { name: srv.name });
  await expect(card).toBeVisible();
  await expect(card.getByText('No access')).toBeVisible();
  await expect(card.getByRole('button', { name: `Request access to ${srv.name}` })).toBeVisible();

  await page.getByRole('radio', { name: 'Tools' }).click();
  await expect(page).toHaveURL(/view=tools/);
  for (const t of Object.values(srv.tools)) await expect(page.getByText(t.qualifiedName, { exact: true })).toBeVisible();
  // the count describes the tool list (not the servers search)
  await expect(page.getByText(/^\d+ tools?$/)).toBeVisible();
  await expect(page.getByText(/servers? ·/)).toHaveCount(0);

  await page.getByRole('radio', { name: 'Servers' }).click();
  await page.getByRole('combobox', { name: 'Access' }).click();
  await page.getByRole('option', { name: 'Available to me' }).click();
  await expect(page).toHaveURL(/access=granted/);
  await expect(page.getByText(/No servers match/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).not.toHaveURL(/access=|q=/);
  await expect(page.getByRole('article', { name: srv.name })).toBeVisible();
});

test('server detail → request access → admin approves → tools are allowed', async ({ page, admin, browser }) => {
  const srv = await seedServer(admin);
  const me = await signIn(page, `user-${uid()}@e2e.test`);
  await page.goto('/catalog');
  await page.getByRole('link', { name: srv.name, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: srv.name })).toBeVisible();
  await expect(page.getByText('Owner: admin', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Tools/ })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Toggle schema for add' }).click();
  await expect(page.getByRole('button', { name: 'Toggle schema for add' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Input schema')).toBeVisible();

  await page.getByRole('button', { name: 'Request access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Request access to ${srv.name}` });
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(dialog.getByText('Tell the reviewer why (at least 10 characters).')).toBeVisible();
  await dialog.getByLabel(/^Reason/).fill('Need the calculator for the quarterly report');
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Requested').first()).toBeVisible();

  // the admin reviews it in their own browser session
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, ADMIN_EMAIL);
  await adminPage.goto('/admin/access-requests');
  const pending = adminPage.getByRole('table', { name: 'Pending access requests' });
  const row = pending.getByRole('row').filter({ hasText: me.me.user.name }).filter({ hasText: srv.name });
  await expect(row).toContainText('Need the calculator for the quarterly report');
  await row.getByRole('button', { name: `Approve request from ${me.me.user.name}` }).click();
  const approve = adminPage.getByRole('dialog', { name: `Approve access to ${srv.name}` });
  await expect(approve.getByRole('radio', { name: me.me.user.name })).toBeChecked();
  await approve.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(row).toBeHidden();
  await adminPage.getByRole('tab', { name: 'Resolved' }).click();
  const resolved = adminPage.getByRole('table', { name: 'Resolved access requests' }).getByRole('row').filter({ hasText: me.me.user.name });
  await expect(resolved).toContainText('Approved');
  await adminContext.close();

  // back on the user's side: every tool is allowed now, and My requests shows the decision
  await page.reload();
  await expect(page.getByRole('tabpanel').getByText('Allowed', { exact: true })).toHaveCount(3);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'My requests' }).click();
  await expect(page.getByRole('row').filter({ hasText: srv.name })).toContainText('Approved');
});
