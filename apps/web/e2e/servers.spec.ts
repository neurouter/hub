// Flow 07 (traces: 07-admin-servers): register the fake upstream, review new tools, sync.
import { ADMIN_EMAIL, UPSTREAM_URL, uid } from './support/api';
import { expect, signIn, test } from './support/fixtures';

test('register an upstream, approve a new tool and sync', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL);
  await page.goto('/admin/servers');
  await page.getByRole('link', { name: 'Register server' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Register a server' })).toBeVisible();

  const id = uid();
  const name = `Calc ${id}`;
  const slug = `calc-${id}`;
  await page.getByLabel('Name', { exact: true }).fill(name);
  await expect(page.getByLabel('Slug', { exact: true })).toHaveValue(slug);
  await page.getByLabel('URL', { exact: true }).fill(`${UPSTREAM_URL}/calc/mcp`);
  await expect(page.getByRole('radio', { name: 'Streamable HTTP' })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^None/ })).toBeChecked();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status')).toContainText('e2e-calc 1.0.0');
  await expect(page.getByRole('status')).toContainText("3 tools found. They'll start disabled until reviewed.");

  await page.getByRole('button', { name: 'Register server' }).click();
  await expect(page).toHaveURL(/\/admin\/servers\/[0-9a-f-]{36}\?tab=tools$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  // the initial sync is followed: tools appear without a reload, disabled until reviewed
  for (const tool of ['add', 'secret_read', 'wipe_disk']) {
    await expect(page.getByRole('link', { name: `${slug}__${tool}` })).toBeVisible();
    await expect(page.getByRole('switch', { name: `Enabled: ${slug}__${tool}` })).toBeDisabled();
  }
  await expect(page.getByText('3 pending review')).toBeVisible();

  await page.getByRole('link', { name: `${slug}__add` }).click();
  await expect(page).toHaveURL(/\?tab=review$/);
  await expect(page.getByLabel('What changed')).toContainText('New tool');
  await page.getByRole('button', { name: 'Approve new definition…' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Approve this definition?' });
  await confirm.getByRole('button', { name: 'Approve definition' }).click();
  await expect(confirm).toBeHidden();
  // the Review tab goes away and the page falls back to Definition (not a blank panel)
  await expect(page.getByRole('tab', { name: /Review/ })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Definition' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Definition' })).toBeVisible();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();

  await page.getByRole('link', { name, exact: true }).click();
  await page.getByRole('tab', { name: 'Tools' }).click();
  await expect(page.getByRole('switch', { name: `Enabled: ${slug}__add` })).toBeChecked();
  await expect(page.getByText('2 pending review')).toBeVisible();

  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText(`Synced ${name}`)).toBeVisible();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByRole('cell', { name: '0 new · 0 changed · 0 removed' })).toBeVisible();
});
