// Access control from the UI: grant a whole server to a group from the group page, and open a
// server to everyone from its Access tab (an agent with no grants can then call its tools).
import { ADMIN_EMAIL } from './support/api';
import { expect, signIn, test } from './support/fixtures';
import { callTool, mcpClient, textOf } from './support/mcp';
import { seedAgentWithKey, seedServer } from './support/seed';

test('add a server-wide grant for a group from the group page', async ({ page, admin }) => {
  const srv = await seedServer(admin);
  const group = await admin.post<{ id: string; name: string }>('/api/groups', { name: `eng-${Date.now().toString(36)}` });

  await signIn(page, ADMIN_EMAIL);
  await page.goto(`/admin/groups/${group.id}?tab=grants`);
  await page.getByRole('button', { name: 'Add grant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add grant' });
  await expect(dialog.getByRole('button', { name: new RegExp(group.name) })).toBeVisible(); // pre-filled subject
  await dialog.getByRole('button', { name: /^Server/ }).click();
  await page.getByRole('option', { name: new RegExp(srv.name) }).click();
  await dialog.getByRole('button', { name: 'Add grant' }).click();
  await expect(page.getByText('Grant added')).toBeVisible();
  await expect(page.getByRole('table').getByText(srv.name).first()).toBeVisible();
  const grants = (await admin.get(`/api/grants?serverId=${srv.id}`)).items as { subject: { id: string }; target: { type: string } }[];
  expect(grants.some((g) => g.subject.id === group.id && g.target.type === 'server')).toBe(true);
});

test('admins make a server available to everyone from its Access tab', async ({ page, admin, user }) => {
  const srv = await seedServer(admin);
  const agent = await seedAgentWithKey(user);
  const add = (c: Awaited<ReturnType<typeof mcpClient>>) => callTool(c, srv.tools.add!.qualifiedName, { a: 2, b: 3 });
  const before = await mcpClient(agent.key);
  expect((await add(before)).isError).toBe(true);
  await before.close();

  await signIn(page, ADMIN_EMAIL);
  await page.goto(`/admin/servers/${srv.id}?tab=access`);
  const everyone = page.getByRole('switch', { name: 'Available to everyone' });
  await expect(everyone).not.toBeChecked();
  await everyone.click();
  await expect(page.getByText(`${srv.name} is available to everyone`)).toBeVisible();
  await expect(everyone).toBeChecked();
  await expect(page.getByRole('table').getByText('Everyone')).toBeVisible();

  // a user with no grants of their own now sees the tools
  const after = await mcpClient(agent.key);
  const r = await add(after);
  expect(r.isError, textOf(r)).toBeFalsy();
  expect(textOf(r)).toContain('5');
  await after.close();

  await everyone.click();
  await expect(everyone).not.toBeChecked();
});
