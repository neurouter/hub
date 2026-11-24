// Flow 13 (traces: 13-observability): overview dashboards, breakdown, sessions and the session timeline.
import { ADMIN_EMAIL } from './support/api';
import { expect, signIn, test } from './support/fixtures';
import { seedTraffic } from './support/traffic';

test('overview KPIs and breakdown include the traffic; the session timeline lists its calls', async ({ page, admin, user }) => {
  const t = await seedTraffic(admin, user, 'e2e-observability');
  const add = t.srv.tools.add!.qualifiedName;

  await signIn(page, ADMIN_EMAIL);
  await page.goto('/observability?range=1h');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('radio', { name: '1h' })).toBeChecked();
  for (const kpi of ['Calls', 'Success rate', 'Error rate', 'Blocked', 'Latency']) await expect(page.getByRole('region', { name: kpi })).toBeVisible();

  // rollups flush every 10 s: reload until this tool shows up in the breakdown
  const byTool = page.getByRole('table', { name: 'Breakdown by tool' });
  await expect(async () => {
    await page.reload();
    await page.getByRole('tab', { name: 'By tool' }).click();
    await expect(byTool.getByRole('row').filter({ hasText: add })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 40_000 });
  await expect(byTool.getByRole('row').filter({ hasText: add })).toContainText('4');

  await page.getByRole('button', { name: 'View as table' }).first().click();
  await expect(page.getByRole('table', { name: 'Calls over time' })).toBeVisible();

  // a breakdown row becomes a scope filter
  await byTool.getByRole('button', { name: `Filter by ${add}` }).click();
  await expect(page).toHaveURL(/toolId=/);

  // sessions → timeline
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Sessions' }).click();
  const session = page.getByRole('row').filter({ hasText: t.agent.name });
  await expect(async () => {
    await page.reload();
    await expect(session).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(session).toContainText('e2e-observability');
  await session.getByRole('link', { name: /^Session / }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Session / })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Session summary' })).toContainText(t.agent.name);
  const calls = page.getByRole('list', { name: 'Session calls' });
  await expect(calls.getByRole('listitem')).toHaveCount(5);
  await calls.getByRole('button', { name: new RegExp(`^View event ${t.srv.tools.secret_read!.qualifiedName}`) }).click();
  const drawer = page.getByRole('dialog', { name: t.srv.tools.secret_read!.qualifiedName });
  await expect(drawer).toContainText('blocked');
});
