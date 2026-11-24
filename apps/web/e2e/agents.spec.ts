// Flow 05 (traces: 05-agent-and-key): create an agent and an API key that is shown exactly once.
import { uid } from './support/api';
import { expect, signIn, test } from './support/fixtures';
import { mcpClient } from './support/mcp';

test('create an agent and an API key; the secret is shown once and works', async ({ page }) => {
  await signIn(page, `user-${uid()}@e2e.test`);
  await page.goto('/agents');
  await expect(page.getByText('No agents yet')).toBeVisible();
  await page.getByRole('button', { name: 'New agent' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await expect(dialog.getByText('Give the agent a name.')).toBeVisible();
  await dialog.getByLabel('Name').fill('report-bot');
  await dialog.getByLabel('Description').fill('Builds the quarterly report');
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 1, name: 'report-bot' })).toBeVisible();

  await page.getByRole('button', { name: 'Create key' }).first().click();
  const create = page.getByRole('dialog', { name: 'Create API key' });
  await create.getByLabel('Name').fill('ci-prod');
  await expect(create.getByRole('combobox', { name: 'Expires' })).toHaveText(/90 days/);
  await create.getByRole('button', { name: 'Create key' }).click();

  const shown = page.getByRole('dialog', { name: 'Key “ci-prod” created' });
  await expect(shown.getByText('This is the only time the key is shown.')).toBeVisible();
  const secret = await shown.getByRole('textbox', { name: 'API key' }).inputValue();
  expect(secret).toMatch(/^nr_live_[0-9A-Z]{10}_[0-9A-Za-z]{43}$/);
  await expect(shown.getByRole('button', { name: 'Close' })).toBeDisabled();
  await shown.getByRole('checkbox', { name: "I've stored this key somewhere safe" }).check();
  await shown.getByRole('button', { name: 'Close' }).click();
  await expect(shown).toBeHidden();

  // listed by prefix only; the secret never appears again
  const keys = page.getByRole('tabpanel', { name: 'Keys' });
  await expect(keys.getByRole('cell', { name: 'ci-prod', exact: true })).toBeVisible();
  await expect(keys.getByRole('cell', { name: 'Active', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('cell', { name: 'ci-prod', exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(secret.split('_').pop()!);

  // the key authenticates an MCP client
  const client = await mcpClient(secret);
  expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['call_tool', 'search_tools']);
  await client.close();

  // the list links to the agent (keyboard reachable)
  await page.goto('/agents');
  await page.getByRole('link', { name: 'report-bot' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'report-bot' })).toBeVisible();
});
