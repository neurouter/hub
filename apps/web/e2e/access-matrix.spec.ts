// Flow 09 (traces: 09-access-matrix): stage grant changes in the matrix and save them in one batch.
import { ADMIN_EMAIL } from './support/api';
import { expect, signIn, test } from './support/fixtures';
import { grant, seedServer } from './support/seed';

test('stage, review and save matrix changes; discard drops staged ones', async ({ page, admin, user }) => {
  const srv = await seedServer(admin);
  const who = user.me.user.name;
  await grant(admin, { type: 'user', id: user.me.user.id }, { type: 'server', id: srv.id });

  await signIn(page, ADMIN_EMAIL);
  await page.goto(`/admin/access-control?view=matrix&server=${srv.id}`);
  const matrix = page.getByRole('table', { name: `Access matrix for ${srv.name}` });
  const cell = (subject: string, tool: string) => matrix.getByRole('radiogroup', { name: `user:${subject} on ${srv.name}__${tool}` });
  await expect(matrix.getByRole('radiogroup', { name: `user:${who} on all ${srv.name} tools` }).getByRole('radio', { name: 'Allow' })).toBeChecked();
  await expect(cell(who, 'secret_read').getByRole('radio', { name: 'Inherit' })).toBeChecked();

  // discard
  await cell(who, 'add').getByRole('radio', { name: 'Deny' }).click();
  const staged = page.getByRole('region', { name: 'Staged changes' });
  await expect(staged).toContainText('1 change staged');
  await staged.getByRole('button', { name: 'Discard' }).click();
  await expect(staged).toBeHidden();
  await expect(cell(who, 'add').getByRole('radio', { name: 'Inherit' })).toBeChecked();

  // two changes: deny one tool for the user, add the admin with an allow
  await cell(who, 'secret_read').getByRole('radio', { name: 'Deny' }).click();
  await page.getByRole('radiogroup', { name: 'New row type' }).getByRole('radio', { name: 'User' }).click();
  await page.getByRole('button', { name: 'Add subject' }).click();
  await page.getByRole('combobox', { name: 'Search add subject' }).fill('admin');
  await page.getByRole('option', { name: 'admin admin@e2e.test' }).click();
  await cell('admin', 'add').getByRole('radio', { name: 'Allow' }).click();
  await expect(staged).toContainText('2 changes staged');
  await expect(staged).toContainText(`deny user:${who} → secret_read`);
  await expect(staged).toContainText('allow user:admin → add');

  await staged.getByRole('button', { name: 'Review & save…' }).click();
  const review = page.getByRole('dialog', { name: 'Review access changes' });
  await expect(review).toContainText('secret_read: inherit → deny');
  await expect(review).toContainText('add: inherit → allow');
  await review.getByRole('button', { name: 'Save 2 changes' }).click();
  await expect(review).toBeHidden();
  await expect(staged).toBeHidden();
  await expect(cell(who, 'secret_read').getByRole('radio', { name: 'Deny' })).toBeChecked();

  // the list view shows the saved grants
  await page.getByRole('radio', { name: 'List' }).click();
  const grantRow = page.getByRole('row').filter({ hasText: `user:${who}` }).filter({ hasText: srv.tools.secret_read!.qualifiedName });
  await expect(grantRow).toContainText('Deny');
  const grants = (await admin.get(`/api/grants?serverId=${srv.id}&limit=50`)).items as { effect: string; target: { id: string } }[];
  expect(grants.filter((g) => g.target.id === srv.tools.secret_read!.id).map((g) => g.effect)).toEqual(['deny']);
});
