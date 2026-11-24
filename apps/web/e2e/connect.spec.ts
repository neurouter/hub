// Flow 06 (traces: 06-connect-client): connect-a-client snippets per client and sign-in method.
import { expect, signIn, test } from './support/fixtures';
import { BASE_URL } from './support/api';
import { seedAgentWithKey } from './support/seed';

test('shows the right snippet for every client in OAuth and API key mode', async ({ page, user, context }) => {
  const agent = await seedAgentWithKey(user);
  await signIn(page, user.me.user.email);
  await page.goto('/connect');
  await expect(page.getByRole('heading', { level: 1, name: 'Connect a client' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Agent' })).toContainText(agent.name);
  const snippet = page.getByTestId('code-snippet');
  const mcpUrl = `${BASE_URL}/mcp`;

  await expect(page.getByRole('radio', { name: /^OAuth/ })).toBeChecked();
  const oauth: Record<string, RegExp> = {
    'Claude Code': new RegExp(`claude mcp add --transport http neurouter ${mcpUrl}[\\s\\S]*Authenticate`),
    Cursor: /"mcpServers"/,
    'VS Code': /"type": "http"/,
    Generic: /OAuth 2\.1/,
  };
  for (const [tab, re] of Object.entries(oauth)) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(snippet).toHaveText(re);
    await expect(snippet).toContainText(mcpUrl);
    await expect(snippet).not.toContainText('Authorization');
  }

  await page.getByRole('radio', { name: /^API key/ }).click();
  const apiKey: Record<string, string> = {
    'Claude Code': '--header "Authorization: Bearer ${NEUROUTER_API_KEY}"',
    Cursor: '"Authorization": "Bearer ${env:NEUROUTER_API_KEY}"',
    'VS Code': '"Authorization": "Bearer ${input:neurouter-key}"',
    Generic: 'Authorization: Bearer <YOUR_API_KEY>',
  };
  for (const [tab, text] of Object.entries(apiKey)) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(snippet).toContainText(text);
    // never the real key
    await expect(snippet).not.toContainText(agent.key);
  }

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Authorization: Bearer <YOUR_API_KEY>');
});
