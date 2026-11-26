import type { ClientConfig } from '@neurouter/shared';

/**
 * Connect-a-client snippets (§5.1, W7). Formats re-verified against each client's docs on
 * 2026-11-24 (frontend Q8):
 * - Claude Code: https://code.claude.com/docs/en/mcp
 *   `claude mcp add --transport http <name> <url> [--header "Authorization: Bearer …"]`;
 *   OAuth: add the server, then run `/mcp` in Claude Code and authenticate.
 * - Cursor: https://cursor.com/docs/context/mcp
 *   `~/.cursor/mcp.json` (or `.cursor/mcp.json`), `{ "mcpServers": { name: { "url", "headers" } } }`,
 *   env interpolation `${env:NAME}`.
 * - VS Code: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
 *   `.vscode/mcp.json`, `{ "inputs": [promptString, password], "servers": { name: { "type": "http", "url", "headers" } } }`,
 *   secret via `${input:id}`.
 * - Generic: MCP Streamable HTTP; OAuth discovery via 401 WWW-Authenticate → protected resource metadata.
 *
 * The key is only interpolated when the user pasted it or just created it; otherwise an
 * environment-variable form is used and the secret never lands in the snippet.
 */
export type ClientId = 'claude' | 'cursor' | 'vscode' | 'generic';
export type AuthMode = 'oauth' | 'api_key';

export const CLIENTS: { id: ClientId; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'generic', label: 'Generic' },
];

export interface SnippetInput {
  config: Pick<ClientConfig, 'mcpUrl' | 'serverName' | 'protocolVersions'>;
  auth: AuthMode;
  /** a key the user pasted or just created (never stored) */
  key?: string | undefined;
  agentName?: string | undefined;
}

export interface Snippet {
  targetLabel: string;
  target: string;
  code: string;
  hint: string;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

export function buildSnippet(client: ClientId, { config, auth, key, agentName }: SnippetInput): Snippet {
  const url = config.mcpUrl;
  const name = config.serverName;
  const useKey = auth === 'api_key';
  const hint = useKey
    ? key
      ? 'This snippet contains your key. Prefer an environment variable over committing it.'
      : 'The key is never inserted unless you paste it or just created it. Set NEUROUTER_API_KEY in your environment instead of committing the key.'
    : `Your client will open a browser to approve access${agentName ? ` as agent “${agentName}”` : ''}. You can revoke it later from the agent’s Authorized apps tab.`;
  switch (client) {
    case 'claude':
      return {
        targetLabel: 'Run in your terminal',
        target: 'shell',
        hint,
        code: useKey
          ? `claude mcp add --transport http ${name} ${url} \\\n  --header "Authorization: Bearer ${key ?? '${NEUROUTER_API_KEY}'}"`
          : `claude mcp add --transport http ${name} ${url}\n\n# Then run /mcp in Claude Code and choose “Authenticate”.`,
      };
    case 'cursor':
      return {
        targetLabel: 'Add to',
        target: '~/.cursor/mcp.json',
        hint,
        code: json({ mcpServers: { [name]: useKey ? { url, headers: { Authorization: `Bearer ${key ?? '${env:NEUROUTER_API_KEY}'}` } } : { url } } }),
      };
    case 'vscode':
      return {
        targetLabel: 'Add to',
        target: '.vscode/mcp.json',
        hint,
        code: useKey
          ? key
            ? json({ servers: { [name]: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } } })
            : json({
                inputs: [{ type: 'promptString', id: 'neurouter-key', description: 'Neurouter Hub API key', password: true }],
                servers: { [name]: { type: 'http', url, headers: { Authorization: 'Bearer ${input:neurouter-key}' } } },
              })
          : json({ servers: { [name]: { type: 'http', url } } }),
      };
    default:
      return {
        targetLabel: 'Any MCP client',
        target: 'Streamable HTTP',
        hint,
        code: [
          `URL:        ${url}`,
          'Transport:  Streamable HTTP (POST)',
          `Protocol:   MCP-Protocol-Version: ${config.protocolVersions.join(' | ')}`,
          useKey
            ? `Auth:       Authorization: Bearer ${key ?? '<YOUR_API_KEY>'}`
            : 'Auth:       OAuth 2.1 (discover via 401 WWW-Authenticate →\n            /.well-known/oauth-protected-resource)',
        ].join('\n'),
      };
  }
}
