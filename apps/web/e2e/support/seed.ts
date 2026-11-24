import { expect } from '@playwright/test';
import { type Api, UPSTREAM_URL, uid } from './api';
import { mcpClient } from './mcp';

export interface SeededTool {
  id: string;
  name: string;
  qualifiedName: string;
}
export interface SeededServer {
  id: string;
  name: string;
  slug: string;
  tools: Record<string, SeededTool>;
}

/** Registers an upstream as `admin`, waits for the initial sync and (optionally) approves every tool definition. */
export async function seedServer(admin: Api, opts: { kind?: 'calc' | 'mutable'; approve?: boolean; name?: string } = {}): Promise<SeededServer & { mutableKey: string }> {
  const id = uid();
  const kind = opts.kind ?? 'calc';
  const name = opts.name ?? `${kind === 'calc' ? 'Calc' : 'Echo'} ${id}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const url = kind === 'calc' ? `${UPSTREAM_URL}/calc/mcp` : `${UPSTREAM_URL}/mutable/${id}/mcp`;
  const srv = await admin.call('POST', '/api/servers', { name, slug, ownerId: admin.me.user.id, url, transport: 'streamable_http', auth: { type: 'none' } }, 201);
  const job = await admin.waitJob(srv.initialSync.jobId);
  expect(job.status).toBe('succeeded');
  const items = (await admin.get(`/api/tools?serverId=${srv.id}&limit=50`)).items as { id: string; name: string; qualifiedName: string }[];
  if (opts.approve !== false) {
    for (const t of items) {
      const diff = await admin.get(`/api/tools/${t.id}/definition-diff`);
      await admin.post(`/api/tools/${t.id}/approve-definition`, { hash: diff.current.hash });
    }
  }
  const tools = Object.fromEntries(items.map((t) => [t.name, { id: t.id, name: t.name, qualifiedName: t.qualifiedName }]));
  return { id: srv.id, name, slug, tools, mutableKey: id };
}

export async function grant(admin: Api, subject: { type: 'user' | 'agent' | 'group'; id: string }, target: { type: 'server' | 'tool'; id: string }, effect: 'allow' | 'deny' = 'allow') {
  return admin.call('POST', '/api/grants', { subject, target, effect }, 201);
}

/** Creates an agent for `user` and returns it with a fresh API key secret. */
export async function seedAgentWithKey(user: Api, name = `bot-${uid()}`): Promise<{ id: string; name: string; key: string }> {
  const agent = await user.post('/api/agents', { name });
  const k = await user.post(`/api/agents/${agent.id}/keys`, { name: 'e2e', expiresAt: null });
  return { id: agent.id, name, key: k.secret };
}

/** A server whose wipe_disk tool requires approval, granted to `user`, plus an agent and a connected MCP client. */
export async function seedApprovalTool(admin: Api, user: Api) {
  const srv = await seedServer(admin);
  await grant(admin, { type: 'user', id: user.me.user.id }, { type: 'server', id: srv.id });
  const wipe = srv.tools.wipe_disk!;
  await admin.patch(`/api/tools/${wipe.id}`, { requiresApproval: true });
  const agent = await seedAgentWithKey(user);
  return { srv, wipe, agent, client: await mcpClient(agent.key, 'e2e-approvals') };
}
