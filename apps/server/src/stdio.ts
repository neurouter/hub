/**
 * Inspection-only stdio entry point (`node apps/server/dist/stdio.js`), for directories that
 * start servers over stdio to read their tool definitions (e.g. Glama's build check).
 *
 * It lists the two tools the gateway really exposes (`search_tools`, `call_tool`) with their real
 * schemas, but it has no database, no credentials and no upstream servers: every call returns an
 * error pointing to the HTTP gateway. Nothing is logged to stdout (stdout is the MCP channel).
 */
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { META_TOOL_DEFINITIONS } from '@neurouter/shared';
import { SERVER_VERSION } from './version.js';

const DOCS = 'https://hub.neurouter.com/docs';

export function createInspectionServer(): Server {
  const server = new Server(
    { name: 'neurouter', title: 'Neurouter Hub', version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: `Neurouter Hub is a self-hosted MCP gateway; this stdio endpoint only describes its tools. Deploy the gateway and connect agents to its /mcp endpoint over HTTP: ${DOCS}`,
    },
  );
  server.setRequestHandler('tools/list', async () => ({ tools: META_TOOL_DEFINITIONS.map((t) => structuredClone(t)) as never }));
  server.setRequestHandler('tools/call', async (req) => ({
    isError: true,
    content: [{ type: 'text', text: `${req.params.name} is not available over stdio: this is an inspection endpoint with no servers behind it. Run Neurouter Hub and connect over HTTP (${DOCS}).` }],
  }));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createInspectionServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`neurouter ${SERVER_VERSION}: stdio inspection endpoint ready\n`);
}
