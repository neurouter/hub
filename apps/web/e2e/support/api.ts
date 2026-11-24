/* eslint-disable @typescript-eslint/no-explicit-any -- seeding reads loosely typed JSON; the UI is what is under test */
import { expect, request, type APIRequestContext, type BrowserContext } from '@playwright/test';

export const BASE_URL = process.env.E2E_BASE_URL!;
export const UPSTREAM_URL = process.env.E2E_UPSTREAM_URL!;
export const ADMIN_EMAIL = 'admin@e2e.test';

/** Short unique suffix so tests never collide on names, slugs or emails. */
export const uid = () => `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Cookie-session API client for seeding (dev login + CSRF header), mirroring what the SPA does.
 * Seeding through the API keeps each test independent and fast; the UI is only used for the
 * flow under test.
 */
export class Api {
  private constructor(
    readonly ctx: APIRequestContext,
    private csrf: string,
    readonly me: { user: { id: string; name: string; email: string }; roles: string[] },
  ) {}

  /** Signs in with dev login. Pass a browser context to share the session cookie with a page. */
  static async login(email: string, context?: BrowserContext): Promise<Api> {
    const ctx = context ? context.request : await request.newContext({ baseURL: BASE_URL });
    const res = await ctx.post(`${BASE_URL}/api/auth/dev-login`, { data: { email } });
    expect(res.status(), `dev login ${email}`).toBe(204);
    const me = await (await ctx.get(`${BASE_URL}/api/me`)).json();
    return new Api(ctx, me.csrfToken, me);
  }

  async call<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, data?: unknown, expected?: number): Promise<T> {
    const res = await this.ctx.fetch(`${BASE_URL}${path}`, { method, headers: { 'x-csrf-token': this.csrf }, ...(data !== undefined ? { data } : {}) });
    if (expected !== undefined) expect(res.status(), `${method} ${path}: ${await res.text()}`).toBe(expected);
    else expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  get = <T = any>(path: string) => this.call<T>('GET', path);
  post = <T = any>(path: string, data: unknown = {}) => this.call<T>('POST', path, data);
  patch = <T = any>(path: string, data: unknown) => this.call<T>('PATCH', path, data);

  async waitJob(jobId: string): Promise<{ status: string; result: unknown }> {
    let job: { status: string; result: unknown } = { status: 'queued', result: null };
    await expect
      .poll(async () => (job = await this.get(`/api/jobs/${jobId}`)).status, { timeout: 30_000 })
      .toMatch(/succeeded|failed/);
    return job;
  }
}
