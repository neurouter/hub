// Flow 10 (traces: 10-traffic): MCP client traffic through the gateway, seen by the user.
import { expect, signIn, test } from './support/fixtures';
import { textOf } from './support/mcp';
import { seedTraffic } from './support/traffic';

test('allowed, blocked and invalid calls; the user sees them in My activity', async ({ page, admin, user }) => {
  const t = await seedTraffic(admin, user);
  expect(t.results).toEqual(['sum=2', 'sum=3', 'sum=4']);
  expect(t.blocked.isError).toBe(true);
  expect(textOf(t.blocked)).toContain('not permitted');
  expect(t.invalid.isError).toBe(true);
  expect(textOf(t.invalid)).toContain('Invalid arguments');

  await signIn(page, user.me.user.email);
  await page.goto('/activity?range=1h');
  await expect(page.getByRole('heading', { level: 1, name: 'My activity' })).toBeVisible();
  // rollups and the audit log are written asynchronously: reload until they land
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('region', { name: 'Calls' })).toContainText('5', { timeout: 1_000 });
    await expect(page.getByRole('cell', { name: t.srv.tools.secret_read!.qualifiedName }).first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Blocked' })).toContainText('1');
});
