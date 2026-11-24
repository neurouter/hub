import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BASE_URL } from './api';

/** An MCP client connected to the gateway with an agent API key (what agents and CI use). */
export async function mcpClient(key: string, name = 'e2e-client'): Promise<Client> {
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return c;
}

/** Calls an upstream tool through the gateway's `call_tool` meta-tool. */
export function callTool(c: Client, name: string, args: Record<string, unknown>, timeoutMs = 120_000) {
  return c.callTool({ name: 'call_tool', arguments: { name, arguments: args } }, { timeout: timeoutMs }) as Promise<{ isError?: boolean; content: { type: string; text?: string }[] }>;
}

export const textOf = (r: { content: { text?: string }[] }) => r.content.map((x) => x.text ?? '').join('\n');
