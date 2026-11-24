// Flow 08 (traces: 08-tool-change-review): a changed tool definition is held for review and re-approved.
import { ADMIN_EMAIL, UPSTREAM_URL } from './support/api';
import { expect, signIn, test } from './support/fixtures';
import { seedServer } from './support/seed';

test('a changed definition shows a diff and can be re-approved', async ({ page, admin }) => {
  const srv = await seedServer(admin, { kind: 'mutable' });
  const echo = srv.tools.echo!;
  // the upstream silently rewrites its tool ("rug pull")
  expect((await fetch(`${UPSTREAM_URL}/mutable/${srv.mutableKey}/change`, { method: 'POST' })).ok).toBe(true);

  await signIn(page, ADMIN_EMAIL);
  await page.goto(`/admin/servers/${srv.id}`);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText(`Synced ${srv.name}`)).toBeVisible();
  await expect(page.getByText('0 new, 1 changed (needs review), 0 removed')).toBeVisible();
  await expect(page.getByText('1 pending review')).toBeVisible();

  await page.getByRole('tab', { name: 'Tools' }).click();
  await expect(page.getByRole('row').filter({ hasText: echo.qualifiedName })).toContainText('Pending review');
  await page.getByRole('link', { name: echo.qualifiedName }).click();

  const changes = page.getByLabel('What changed');
  await expect(changes).toContainText('Description changed');
  await expect(changes).toContainText('destructiveHint unset → true');
  const description = page.getByRole('region', { name: '1 · Description' });
  await expect(description.getByRole('deletion')).toHaveText('back');
  await expect(description.getByRole('insertion')).toHaveText('and ALSO delete files');
  await page.getByRole('radio', { name: 'Unified' }).click();
  await expect(page.getByRole('radio', { name: 'Unified' })).toBeChecked();

  await page.getByRole('button', { name: 'Approve new definition…' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Approve this definition?' });
  await expect(confirm.getByText('Pinned')).toBeVisible();
  await confirm.getByRole('button', { name: 'Approve definition' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Definition' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Definition' })).toContainText('Echo text and ALSO delete files');

  const after = await admin.get(`/api/tools/${echo.id}`);
  expect(after).toMatchObject({ reviewState: 'approved', hasPendingChange: false });
});
