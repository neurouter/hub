// Smoke at 375 px (traces: 15-mobile): catalog and approvals on a phone.
import { type Page } from '@playwright/test';
import { ADMIN_EMAIL, uid } from './support/api';
import { expect, signIn, test } from './support/fixtures';
import { callTool, textOf } from './support/mcp';
import { seedApprovalTool, seedServer } from './support/seed';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

const noHorizontalScroll = (page: Page) =>
  expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

test('catalog on a phone: search, filters sheet and server cards', async ({ page, admin }) => {
  const srv = await seedServer(admin);
  await signIn(page, `user-${uid()}@e2e.test`);
  await page.goto('/catalog');
  await expect(page.getByRole('heading', { level: 1, name: 'Catalog' })).toBeVisible();
  // the sidebar is off-canvas
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
  await page.getByRole('searchbox', { name: 'Search servers and tools' }).fill(srv.name);
  const card = page.getByRole('article', { name: srv.name });
  await expect(card).toBeVisible();
  await expect(card.getByText('3 tools')).toBeVisible();
  await noHorizontalScroll(page);

  await page.getByRole('button', { name: 'Filters' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  await page.getByRole('button', { name: 'Toggle sidebar (Ctrl+B)' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'My agents' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'My agents' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My agents' })).toBeVisible();
});

test('approvals on a phone: approve a held call and see it under Recent', async ({ page, admin, user }) => {
  const { wipe, agent, client } = await seedApprovalTool(admin, user);
  const vol = `phone-${uid()}`;
  const held = callTool(client, wipe.qualifiedName, { volume: vol });

  await signIn(page, ADMIN_EMAIL);
  await page.goto('/admin/approvals');
  const card = page.getByRole('article').filter({ hasText: vol });
  await expect(card).toBeVisible();
  await expect(card).toContainText(`${agent.name} for ${user.me.user.name}`);
  await noHorizontalScroll(page);
  await card.getByRole('button', { name: `Approve ${wipe.qualifiedName}` }).click();
  await expect(card).toBeHidden();
  expect(textOf(await held)).toBe(`wiped ${vol}`);
  await client.close();

  await page.getByRole('tab', { name: 'Recent' }).click();
  await expect(page.getByRole('list', { name: 'Recent decisions' }).getByRole('listitem').filter({ hasText: agent.name })).toContainText('Approved');
});
