// Pinning modes and bulk review: a changed definition is approved from the server's Tools tab in
// strict mode, and applied without review (but flagged) once an admin switches to monitor mode.
import { ADMIN_EMAIL, UPSTREAM_URL } from './support/api';
import { expect, signIn, test } from './support/fixtures';
import { seedServer } from './support/seed';

test('strict: review all pending changes of a server at once', async ({ page, admin }) => {
  const srv = await seedServer(admin, { kind: 'mutable' });
  const echo = srv.tools.echo!;
  expect((await fetch(`${UPSTREAM_URL}/mutable/${srv.mutableKey}/change`, { method: 'POST' })).ok).toBe(true);

  await signIn(page, ADMIN_EMAIL);
  await page.goto(`/admin/servers/${srv.id}`);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText(`Synced ${srv.name}`)).toBeVisible();

  await page.getByRole('tab', { name: 'Tools' }).click();
  await expect(page.getByText('1 definition is waiting for review.')).toBeVisible();
  await page.getByRole('button', { name: 'Review all…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review pending definitions' });
  const item = dialog.getByRole('listitem').filter({ hasText: echo.qualifiedName });
  await expect(item).toContainText('Description changed');
  await expect(item).toContainText('destructiveHint unset → true');
  await dialog.getByRole('button', { name: 'Approve 1 selected' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('1 definition is waiting for review.')).toHaveCount(0);

  const after = await admin.get(`/api/tools/${echo.id}`);
  expect(after).toMatchObject({ reviewState: 'approved', hasPendingChange: false, description: 'Echo text and ALSO delete files' });
});

test('monitor: an admin switches the server; the change applies at once and is flagged', async ({ page, admin }) => {
  const srv = await seedServer(admin, { kind: 'mutable' });
  const echo = srv.tools.echo!;

  await signIn(page, ADMIN_EMAIL);
  await page.goto(`/admin/servers/${srv.id}?tab=settings`);
  await page.getByRole('radio', { name: /^Monitor/ }).click();
  await expect(page.getByText('Server saved')).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Monitor/ })).toBeChecked();

  expect((await fetch(`${UPSTREAM_URL}/mutable/${srv.mutableKey}/change`, { method: 'POST' })).ok).toBe(true);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText(`Synced ${srv.name}`)).toBeVisible();

  await page.goto(`/admin/tools/${echo.id}`);
  await expect(page.getByText(/^Applied automatically/)).toBeVisible();
  await expect(page.getByText('Enabled', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Blocked until reviewed')).toHaveCount(0);
  await expect(page.getByRole('tabpanel', { name: 'Definition' })).toContainText('Echo text and ALSO delete files');
  // the version history (on the Definition tab) records the automatic decision
  await expect(page.getByRole('tabpanel', { name: 'Definition' }).getByText(/automatically \(no review\)/).first()).toBeVisible();
});
