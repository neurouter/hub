// Flow 12 (traces: 12-audit): audit log filters, event drawer, CSV export and hash-chain verify.
import { readFile } from 'node:fs/promises';
import { ADMIN_EMAIL } from './support/api';
import { expect, signIn, test } from './support/fixtures';
import { seedTraffic } from './support/traffic';

test('filter by agent and decision, open the drawer, export CSV and verify the chain', async ({ page, admin, user }) => {
  const t = await seedTraffic(admin, user, 'e2e-audit');
  const blockedTool = t.srv.tools.secret_read!.qualifiedName;
  const addTool = t.srv.tools.add!.qualifiedName;

  await signIn(page, ADMIN_EMAIL);
  await page.goto('/audit');
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Tool calls' })).toBeChecked();

  // Agent filter (entity picker), written to the URL
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('combobox', { name: /Search agent/i }).fill(t.agent.name);
  await page.getByRole('option', { name: new RegExp(t.agent.name) }).click();
  await expect(page).toHaveURL(/agentId=/);
  const rows = page.getByRole('row').filter({ hasText: t.agent.name });
  await expect(async () => {
    await page.reload();
    await expect(rows).toHaveCount(5, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  // Decision filter: blocked
  await page.getByRole('button', { name: 'Decision' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'blocked' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/decision=/);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(blockedTool);

  // drawer
  await rows.getByRole('button', { name: blockedTool }).click();
  const drawer = page.getByRole('dialog', { name: blockedTool });
  await expect(drawer).toContainText('blocked');
  await expect(drawer).toContainText(t.agent.name);
  await expect(drawer.getByRole('heading', { name: 'INTEGRITY' })).toBeVisible();
  await expect(page).toHaveURL(/event=/);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page).not.toHaveURL(/event=/);

  // reset, then export what the filters select
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('combobox', { name: /Search agent/i }).fill(t.agent.name);
  await page.getByRole('option', { name: new RegExp(t.agent.name) }).click();
  await page.getByRole('button', { name: 'Export' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'CSV' }).click();
  const download = await downloadPromise;
  const csv = await readFile((await download.path())!, 'utf8');
  const lines = csv.trim().split('\n');
  expect(lines[0]).toMatch(/^seq,id,ts,kind,/);
  expect(lines).toHaveLength(6);
  expect(csv).toContain(addTool);
  expect(csv).toContain(blockedTool);

  // admin changes view
  await page.getByRole('radio', { name: 'Admin changes' }).click();
  await expect(page).toHaveURL(/kind=admin/);

  // hash-chain verification
  await page.getByRole('button', { name: 'Verify integrity…' }).click();
  const verify = page.getByRole('dialog', { name: 'Verify audit chain' });
  await verify.getByRole('button', { name: 'Start verification' }).click();
  await expect(verify).toContainText(/Verified [\d,]+ entries \(seq 1–[\d,]+\)/);
  await verify.getByRole('button', { name: 'Close', exact: true }).first().click();
});
