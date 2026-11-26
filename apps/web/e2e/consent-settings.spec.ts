// Flow 14 (traces: 14-oauth-consent-settings): OAuth consent page and the settings pages.
import { ADMIN_EMAIL, uid } from './support/api';
import { expect, signIn, test } from './support/fixtures';
import { REDIRECT_URI, authorizeUrl } from './support/oauth';

test.describe('OAuth consent', () => {
  test.beforeEach(async ({ page }) => {
    // stand in for the client's loopback listener
    await page.route(`${REDIRECT_URI}**`, (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'client callback' }));
  });

  test('approving redirects back with a code and creates an OAuth agent', async ({ page }) => {
    const me = await signIn(page, `user-${uid()}@e2e.test`);
    const app = `E2E Desktop ${uid()}`;
    await page.goto(await authorizeUrl(app));
    await expect(page).toHaveURL(/\/auth\/consent\?request=/);
    await expect(page.getByRole('heading', { level: 1, name: `${app} wants to use Neurouter Hub as you` })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText("Neurouter Hub couldn't verify who made this app");
    await expect(page.getByText("You'll be sent to 127.0.0.1:53682")).toBeVisible();
    await expect(page.getByRole('list', { name: 'Requested permissions' })).toContainText('mcp:tools');
    await expect(page.getByRole('combobox', { name: 'Appears in audit as agent' })).toContainText(`@ ${me.me.user.name}`);
    await expect(page.getByText(me.me.user.email)).toBeVisible();

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:53682\/callback\?code=[^&]+&state=e2e-state&iss=/);

    await page.goto('/agents');
    const agentLink = page.getByRole('link', { name: new RegExp(`@ ${me.me.user.name}$`) });
    await expect(page.getByRole('row').filter({ has: agentLink })).toContainText('OAuth client');
    await agentLink.click();
    await page.getByRole('tab', { name: 'Authorized apps' }).click();
    const apps = page.getByRole('table', { name: 'Authorized apps' });
    await expect(apps.getByRole('row').filter({ hasText: app })).toContainText('mcp:tools');
  });

  test('denying redirects back with access_denied', async ({ page }) => {
    await signIn(page, `user-${uid()}@e2e.test`);
    await page.goto(await authorizeUrl(`E2E Denied ${uid()}`));
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:53682\/callback\?error=access_denied/);
  });
});

test.describe('settings', () => {
  test('profile and appearance (theme, time display, density)', async ({ page }) => {
    const me = await signIn(page, `user-${uid()}@e2e.test`);
    await page.goto('/settings/profile');
    await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
    await expect(page.getByText(me.me.user.email)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Roles' })).toBeVisible();

    await page.getByRole('link', { name: 'Appearance' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /^System/ })).toBeChecked();
    await page.getByRole('radio', { name: 'UTC' }).click();
    await page.getByRole('radio', { name: /^Compact/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    await page.getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    // theme follows the account; time and density stay on this device
    await page.reload();
    await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'UTC' })).toBeChecked();
    await expect(page.getByRole('radio', { name: /^Compact/ })).toBeChecked();
  });

  test('admin gateway settings: every tab renders and a rate limit saves', async ({ page, admin }) => {
    await signIn(page, ADMIN_EMAIL);
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Gateway settings' })).toBeVisible();
    const tabs = { General: 'Retention', 'Rate limits': 'Per agent', Redaction: 'Redaction rules', Authentication: 'Identity provider (OIDC)', 'OAuth clients': null, Export: 'Audit webhook', System: 'Runtime' };
    for (const [tab, heading] of Object.entries(tabs)) {
      await page.getByRole('tab', { name: tab }).click();
      const panel = page.getByRole('tabpanel', { name: tab });
      await expect(panel).toBeVisible();
      if (heading) await expect(panel.getByRole('heading', { name: heading })).toBeVisible();
    }

    await page.getByRole('tab', { name: 'Rate limits' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Rate limits' });
    const burst = panel.getByRole('spinbutton', { name: 'Burst' }).first();
    const before = await burst.inputValue();
    const next = String(500 + Math.floor(Math.random() * 400));
    await expect(panel.getByRole('button', { name: 'Save' })).toBeDisabled();
    await burst.fill(next);
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog', { name: 'Saved' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('tabpanel', { name: 'Rate limits' }).getByRole('spinbutton', { name: 'Burst' }).first()).toHaveValue(next);
    // the API reflects the saved value
    const settings = await admin.get('/api/settings');
    expect(settings.rateLimits.agent.burst).toBe(Number(next));
    expect(Number(before)).toBeGreaterThan(0);
  });
});
