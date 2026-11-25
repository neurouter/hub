// MCP server library: an admin enables registry sync (a local fake registry), finds a server,
// checks it (connect without credentials + tool lint → grade), and adds it to the gateway.
import { ADMIN_EMAIL, UPSTREAM_URL } from './support/api';
import { expect, signIn, test } from './support/fixtures';

test('enable sync, search, check and add a library server to the gateway', async ({ page, admin }) => {
  await signIn(page, ADMIN_EMAIL);
  await page.goto('/admin/library');
  const status = await admin.get<{ enabled: boolean }>('/api/library/status');
  if (!status.enabled) {
    await expect(page.getByText('Registry sync is off')).toBeVisible();
    await page.getByRole('button', { name: 'Enable registry sync…' }).click();
  } else {
    await page.getByRole('button', { name: 'Settings' }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'Library settings' });
  const toggle = dialog.getByRole('switch', { name: 'Sync from the registry' });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await dialog.getByLabel('Registry URL').fill(`${UPSTREAM_URL}/registry`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Library settings saved')).toBeVisible();

  await page.getByRole('button', { name: 'Sync now' }).click();
  const list = page.getByRole('list', { name: 'Library servers' });
  await expect(list.getByRole('link', { name: 'E2E Calculator' })).toBeVisible({ timeout: 20_000 });
  // stdio-only servers are hidden until asked for
  await expect(list.getByText('io.github.e2e-labs/files')).toHaveCount(0);
  await page.getByRole('switch', { name: 'Local-only servers' }).click();
  await expect(list.getByText('io.github.e2e-labs/files')).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search the library' }).fill('multiplies');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByRole('link', { name: 'E2E Calculator' }).click();

  await expect(page.getByRole('heading', { name: 'E2E Calculator' })).toBeVisible();
  await page.getByRole('button', { name: /Check (now|again)/ }).click();
  await expect(page.getByText(/^Checked/).first()).toBeVisible();
  await expect(page.getByText(/Connected without credentials/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Grade breakdown' })).toContainText('Tool definitions');
  // the tools the check listed, with their parameters
  await expect(page.getByRole('list', { name: 'Tools' }).getByRole('listitem').first()).toBeVisible();
  // plain-HTTP endpoint: a red flag that caps the grade
  await expect(page.getByRole('list', { name: 'Warnings' })).toContainText('The endpoint is plain HTTP.');

  // (a retry of this test finds the server it added the first time)
  if (await page.getByRole('link', { name: 'Open in gateway' }).isVisible()) return;
  const entryUrl = page.url();
  await page.getByRole('link', { name: /Add to gateway/ }).click();
  await expect(page.getByText('From the library')).toBeVisible();
  await expect(page.getByLabel('URL')).toHaveValue(`${UPSTREAM_URL}/library/calc/mcp`);
  const slug = `calc-${Date.now().toString(36)}`;
  await page.getByLabel('Slug').fill(slug);
  await page.getByRole('button', { name: 'Register server' }).click();
  await expect(page.getByText('Server registered')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/servers\/[^/?]+\?tab=tools/);
  await page.goto(entryUrl);
  await expect(page.getByRole('link', { name: 'Open in gateway' })).toBeVisible();

  const servers = await admin.get<{ items: Array<{ id: string; slug: string }> }>('/api/servers?limit=200');
  const created = servers.items.find((s) => s.slug === slug)!;
  const quality = await admin.get<{ version: number; sources: string[] }>(`/api/servers/${created.id}/quality`);
  expect(quality.version).toBe(1);
  expect(quality.sources).toContain('registry');
});
