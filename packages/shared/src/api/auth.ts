import * as z from 'zod';
import { endpoint } from './endpoint.js';

export const AuthProviderId = z.enum(['oidc', 'dev']);
export type AuthProviderId = z.infer<typeof AuthProviderId>;

export const AuthProviders = z.object({
  productName: z.string(),
  providers: z.array(z.object({ id: AuthProviderId, displayName: z.string() })),
});
export type AuthProviders = z.infer<typeof AuthProviders>;

/** Error codes the backend puts on `/auth/login?error=`. `session_expired` is set by the SPA itself. */
export const LoginErrorCode = z.enum(['access_denied', 'no_account', 'disabled', 'idp_error', 'session_expired']);
export type LoginErrorCode = z.infer<typeof LoginErrorCode>;

export const LoginQuery = z.object({ returnTo: z.string().max(2048).optional() });
export type LoginQuery = z.infer<typeof LoginQuery>;

export const DevLoginBody = z.object({ email: z.email().max(320), name: z.string().min(1).max(200).optional() });
export type DevLoginBody = z.infer<typeof DevLoginBody>;

export const LogoutResponse = z.object({ redirectTo: z.string() });
export type LogoutResponse = z.infer<typeof LogoutResponse>;

/**
 * True when `returnTo` is a same-origin, path-only target (`/x`, not `//x`, `/\x`, `https://…`, `javascript:`).
 * Used by both the backend (callback redirect) and the SPA (login page).
 */
export function isSafeReturnTo(value: string | null | undefined): value is string {
  if (!value || typeof value !== 'string' || value.length > 2048) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  // reject control chars / whitespace tricks such as "/\t/evil.com"
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  if (value.includes('\\')) return false;
  return true;
}

export const authEndpoints = {
  providers: endpoint({
    method: 'GET', path: '/api/auth/providers', kind: 'json', access: ['public'],
    summary: 'Login page info', response: AuthProviders,
  }),
  login: endpoint({
    method: 'GET', path: '/api/auth/login', kind: 'navigation', status: 302, access: ['public'],
    summary: 'Start OIDC login (302 to IdP)', query: LoginQuery,
  }),
  callback: endpoint({
    method: 'GET', path: '/api/auth/callback', kind: 'navigation', status: 302, access: ['public'],
    summary: 'OIDC callback (302 to returnTo or /auth/login?error=)',
  }),
  devLogin: endpoint({
    method: 'POST', path: '/api/auth/dev-login', kind: 'empty', access: ['public'],
    summary: 'Dev-only email login (AUTH_DEV_LOGIN, NODE_ENV=development)', body: DevLoginBody,
  }),
  logout: endpoint({
    method: 'POST', path: '/api/auth/logout', kind: 'json', access: ['user'],
    summary: 'Sign out of the current session', response: LogoutResponse,
  }),
} as const;
