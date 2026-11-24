import { createHash, randomBytes } from 'node:crypto';
import { BASE_URL } from './api';

export const REDIRECT_URI = 'http://127.0.0.1:53682/callback';

/** Registers a public client via DCR and returns an /oauth/authorize URL (PKCE S256), like an MCP client would. */
export async function authorizeUrl(clientName: string): Promise<string> {
  const reg = await fetch(`${BASE_URL}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  if (!reg.ok) throw new Error(`DCR failed: ${reg.status} ${await reg.text()}`);
  const { client_id } = (await reg.json()) as { client_id: string };
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const u = new URL(`${BASE_URL}/oauth/authorize`);
  const params = { response_type: 'code', client_id, redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:tools', state: 'e2e-state', resource: `${BASE_URL}/mcp` };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}
