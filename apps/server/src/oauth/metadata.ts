import { MCP_SCOPE } from '../auth/mcp/authenticate.js';

export const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [MCP_SCOPE]: 'Use the MCP tools you have been granted, on your behalf, through this gateway',
};
export const SUPPORTED_SCOPES = [MCP_SCOPE] as const;

/** RFC 8414 authorization server metadata for the gateway AS (backend §7.4). */
export function authorizationServerMetadata(publicUrl: string, opts: { dcrEnabled: boolean }) {
  return {
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    revocation_endpoint: `${publicUrl}/oauth/revoke`,
    ...(opts.dcrEnabled ? { registration_endpoint: `${publicUrl}/oauth/register` } : {}),
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: [...SUPPORTED_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${publicUrl}/connect`,
  };
}

/** Parses a space-delimited scope; empty → the default `mcp:tools`. Returns null when any scope is unknown. */
export function parseScope(scope: string | undefined | null): string[] | null {
  const parts = (scope ?? '').split(/\s+/).filter(Boolean);
  if (!parts.length) return [MCP_SCOPE];
  if (parts.some((p) => !(SUPPORTED_SCOPES as readonly string[]).includes(p))) return null;
  return [...new Set(parts)];
}
