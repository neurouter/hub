import { type Api } from './api';
import { callTool, mcpClient, textOf } from './mcp';
import { grant, seedAgentWithKey, seedServer, type SeededServer } from './seed';

/**
 * Seeds a server the user can use (secret_read denied) plus an agent, and makes a mix of calls
 * with the MCP client: 3 allowed `add`, 1 blocked `secret_read`, 1 invalid-args `add`.
 */
export async function seedTraffic(admin: Api, user: Api, clientName = 'e2e-traffic') {
  const srv = await seedServer(admin);
  await grant(admin, { type: 'user', id: user.me.user.id }, { type: 'server', id: srv.id });
  await grant(admin, { type: 'user', id: user.me.user.id }, { type: 'tool', id: srv.tools.secret_read!.id }, 'deny');
  const agent = await seedAgentWithKey(user);
  const c = await mcpClient(agent.key, clientName);
  const results: string[] = [];
  for (let i = 0; i < 3; i++) results.push(textOf(await callTool(c, srv.tools.add!.qualifiedName, { a: i, b: 2 })));
  const blocked = await callTool(c, srv.tools.secret_read!.qualifiedName, { key: 'x' });
  const invalid = await callTool(c, srv.tools.add!.qualifiedName, { a: 'x' });
  await c.close();
  return { srv: srv as SeededServer, agent, results, blocked, invalid };
}
