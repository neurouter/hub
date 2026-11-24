// Flow 11 (traces: 11-approvals, 10-traffic): calls held for approval, approved and denied from the queue.
import { ADMIN_EMAIL, uid } from './support/api';
import { expect, signIn, test } from './support/fixtures';
import { callTool, textOf } from './support/mcp';
import { seedApprovalTool } from './support/seed';

test('approve one held call and deny another', async ({ page, admin, user }) => {
  const { wipe, agent, client } = await seedApprovalTool(admin, user);
  const okVol = `approve-${uid()}`;
  const noVol = `deny-${uid()}`;
  const token = `ghp_${'q'.repeat(36)}`;
  const approved = callTool(client, wipe.qualifiedName, { volume: okVol, token });
  const denied = callTool(client, wipe.qualifiedName, { volume: noVol });

  await signIn(page, ADMIN_EMAIL);
  await page.goto('/admin/approvals');
  await expect(page.getByText('Live')).toBeVisible();
  const first = page.getByRole('article').filter({ hasText: okVol });
  const second = page.getByRole('article').filter({ hasText: noVol });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(first).toContainText(agent.name);
  await expect(first).toContainText(user.me.user.name);
  await expect(first).toContainText('REDACTED');
  await expect(first).not.toContainText(token);

  await first.getByRole('button', { name: `Approve ${wipe.qualifiedName}` }).click();
  await expect(first).toBeHidden();
  const ok = await approved;
  expect(ok.isError).toBeFalsy();
  expect(textOf(ok)).toBe(`wiped ${okVol}`);

  await second.getByRole('button', { name: `Deny ${wipe.qualifiedName}` }).click();
  await expect(second.getByRole('button', { name: 'Deny call' })).toBeDisabled();
  await second.getByLabel(/Reason for denying/).fill('Not during the freeze');
  await second.getByRole('button', { name: 'Deny call' }).click();
  await expect(second).toBeHidden();
  const no = await denied;
  expect(no.isError).toBe(true);
  expect(textOf(no)).toContain('Not during the freeze');
  await client.close();

  await page.getByRole('tab', { name: 'Recent decisions' }).click();
  const recent = page.getByRole('row').filter({ hasText: agent.name });
  await expect(recent.filter({ hasText: 'Approved' })).toHaveCount(1);
  await expect(recent.filter({ hasText: 'Denied' })).toHaveCount(1);
});
