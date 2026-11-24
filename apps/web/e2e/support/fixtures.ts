import { test as base, expect, type Page } from '@playwright/test';
import { ADMIN_EMAIL, Api, uid } from './api';

/** Signs the page's browser context in via dev login (API), so tests start on the page under test. */
export async function signIn(page: Page, email: string): Promise<Api> {
  return Api.login(email, page.context());
}

interface Fixtures {
  /** An API session for the bootstrap admin (separate from the page). */
  admin: Api;
  /** A fresh plain user (unique email) with its own API session. */
  user: Api;
}

export const test = base.extend<Fixtures>({
  // Playwright requires the object pattern even when a fixture uses no other fixtures
  // eslint-disable-next-line no-empty-pattern
  admin: async ({}, use) => {
    const a = await Api.login(ADMIN_EMAIL);
    await use(a);
    await a.ctx.dispose();
  },
  // eslint-disable-next-line no-empty-pattern
  user: async ({}, use) => {
    const u = await Api.login(`user-${uid()}@e2e.test`);
    await use(u);
    await u.ctx.dispose();
  },
});

export { expect };
