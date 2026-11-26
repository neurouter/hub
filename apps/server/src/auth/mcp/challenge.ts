import { MCP_SCOPE } from './authenticate.js';

/** RFC 9728 PRM location for the MCP resource. */
export function resourceMetadataUrl(publicUrl: string): string {
  return `${publicUrl}/.well-known/oauth-protected-resource/mcp`;
}

/** Protected Resource Metadata document (RFC 9728, backend §7.4). */
export function protectedResourceMetadata(publicUrl: string, resourceUri: string) {
  return {
    resource: resourceUri,
    authorization_servers: [publicUrl],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Neurouter Hub',
  };
}

/**
 * `WWW-Authenticate` for 401/403 (backend §5.2): always names the PRM and scope; adds
 * `error="invalid_token"` when a token was presented, `insufficient_scope` for 403.
 */
export function bearerChallenge(publicUrl: string, error?: 'invalid_token' | 'insufficient_scope', description?: string): string {
  const parts = [`resource_metadata="${resourceMetadataUrl(publicUrl)}"`, `scope="${MCP_SCOPE}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/["\\]/g, '')}"`);
  return `Bearer ${parts.join(', ')}`;
}
