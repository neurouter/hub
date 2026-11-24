import { sql, type Kysely } from 'kysely';
import { can, isAdmin, type Agent, type AgentAccess, type AgentScope, type ApiKey, type CreateAgentBody, type CreateApiKeyBody, type CreateApiKeyResponse, type ListAgentsQuery, type UpdateAgentBody } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { fromIso, toIso, toIsoOrNull } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { toBool } from '../lib/json.js';
import { applyKeyset, containsCi, keysetPage, type KeysetSpec } from '../lib/keyset.js';
import { clampLimit } from '../lib/pagination.js';
import { loadAclPrincipal, type AclService } from '../policy/acl-cache.js';
import { generateApiKey, hashSecret } from './api-key-format.js';
import type { UserSubject } from './principal.js';
import { AUTH_REVOKED_CHANNEL } from './users.service.js';

type AgentRowDb = {
  id: string;
  owner_user_id: string;
  owner_name: string;
  name: string;
  description: string;
  kind: 'api' | 'oauth_client';
  oauth_client_id: string | null;
  narrowed: 0 | 1;
  status: 'active' | 'disabled' | 'deleted';
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
};

export class AgentsService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly pepper: string,
    private readonly audit: AuditRecorder,
    private readonly acl: AclService,
    private readonly coord?: CoordinationStore,
  ) {}

  private base() {
    return this.db
      .selectFrom('agents as a')
      .innerJoin('users as u', 'u.id', 'a.owner_user_id')
      .select(['a.id', 'a.owner_user_id', 'u.name as owner_name', 'a.name', 'a.description', 'a.kind', 'a.oauth_client_id', 'a.narrowed', 'a.status', 'a.last_seen_at', 'a.created_at', 'a.updated_at'])
      .where('a.status', '!=', 'deleted');
  }

  private async toApi(rows: AgentRowDb[], viewer?: UserSubject): Promise<Agent[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const now = this.clock.now();
    const [keys, clients] = await Promise.all([
      this.db
        .selectFrom('api_keys')
        .select(['agent_id', sql<number>`count(*)`.as('n')])
        .where('agent_id', 'in', ids)
        .where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
        .groupBy('agent_id')
        .execute(),
      this.db.selectFrom('oauth_clients').select(['id', 'client_name']).where('id', 'in', rows.map((r) => r.oauth_client_id).filter((x): x is string => !!x)).execute(),
    ]);
    return rows.map((r) => {
      const client = clients.find((c) => c.id === r.oauth_client_id);
      const out: Agent = {
        id: r.id,
        name: r.name,
        description: r.description,
        owner: { id: r.owner_user_id, name: r.owner_name },
        kind: r.kind,
        status: r.status === 'deleted' ? 'disabled' : r.status,
        activeKeyCount: Number(keys.find((k) => k.agent_id === r.id)?.n ?? 0),
        lastUsedAt: toIsoOrNull(r.last_seen_at),
        oauthClient: client ? { id: client.id, name: client.client_name } : null,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
      };
      if (viewer) out.actions = this.actions(r, viewer);
      return out;
    });
  }

  private actions(r: Pick<AgentRowDb, 'owner_user_id' | 'kind'>, viewer: UserSubject): string[] {
    const self = r.owner_user_id === viewer.id || isAdmin(viewer);
    if (!self) return [];
    const out = ['update', 'delete', 'edit_scope'];
    if (r.kind === 'api') out.push('create_key');
    out.push('revoke_keys');
    return out;
  }

  /** Loads an agent the viewer may read (owner, admin, auditor); 404 otherwise (no existence leak). */
  private async loadReadable(id: string, viewer: UserSubject): Promise<AgentRowDb> {
    const row = (await this.base().where('a.id', '=', id).executeTakeFirst()) as AgentRowDb | undefined;
    if (!row || (row.owner_user_id !== viewer.id && !can(viewer, 'agents:readAll'))) throw AppError.notFound('Agent');
    return row;
  }

  /** Loads an agent the viewer may mutate (owner or admin). Auditors get 403, strangers 404. */
  private async loadWritable(id: string, viewer: UserSubject): Promise<AgentRowDb> {
    const row = await this.loadReadable(id, viewer);
    if (row.owner_user_id !== viewer.id && !isAdmin(viewer)) throw AppError.forbidden();
    return row;
  }

  async list(q: ListAgentsQuery, viewer: UserSubject) {
    const owner = q.owner ?? 'me';
    if (owner !== 'me' && owner !== viewer.id && !can(viewer, 'agents:readAll')) throw AppError.forbidden('Only admins and auditors can list other users’ agents');
    const limit = clampLimit(q.limit);
    let qb = this.base();
    if (owner === 'me') qb = qb.where('a.owner_user_id', '=', viewer.id);
    else if (owner !== 'all') qb = qb.where('a.owner_user_id', '=', owner);
    if (q.q) qb = qb.where((eb) => containsCi(eb.ref('a.name'), q.q!));
    const sort = q.sort ?? 'name';
    const spec: KeysetSpec =
      sort === 'name'
        ? { sortExpr: sql<string>`lower(a.name)`, idExpr: sql<string>`a.id`, order: q.order ?? 'asc', kind: 'string' }
        : { sortExpr: sort === 'createdAt' ? sql<number>`a.created_at` : sql<number>`coalesce(a.last_seen_at, 0)`, idExpr: sql<string>`a.id`, order: q.order ?? 'desc', kind: 'number' };
    const rows = (await applyKeyset(qb, spec, q.cursor, limit).execute()) as AgentRowDb[];
    const page = keysetPage(rows, limit, (r) => r, (r) => [sort === 'name' ? r.name.toLowerCase() : sort === 'createdAt' ? r.created_at : (r.last_seen_at ?? 0), r.id]);
    return { items: await this.toApi(page.items), nextCursor: page.nextCursor };
  }

  async get(id: string, viewer: UserSubject): Promise<Agent> {
    return (await this.toApi([await this.loadReadable(id, viewer)], viewer))[0]!;
  }

  async create(body: CreateAgentBody, viewer: UserSubject): Promise<Agent> {
    await this.assertNameFree(viewer.id, body.name);
    const now = this.clock.now();
    const id = newId();
    await this.db
      .insertInto('agents')
      .values({ id, owner_user_id: viewer.id, name: body.name, description: body.description ?? '', kind: 'api', oauth_client_id: null, exposure_mode: null, rate_limit: null, last_seen_at: null, created_at: now, updated_at: now })
      .execute();
    this.audit.admin({ actorUserId: viewer.id, action: 'agent.create', targetType: 'agent', targetId: id, after: body });
    return this.get(id, viewer);
  }

  private async assertNameFree(ownerId: string, name: string, exceptId?: string): Promise<void> {
    let q = this.db.selectFrom('agents').select('id').where('owner_user_id', '=', ownerId).where('name', '=', name);
    if (exceptId) q = q.where('id', '!=', exceptId);
    if (await q.executeTakeFirst()) throw AppError.conflict('You already have an agent with this name');
  }

  async update(id: string, body: UpdateAgentBody, viewer: UserSubject): Promise<Agent> {
    const row = await this.loadWritable(id, viewer);
    if (body.name !== undefined && body.name !== row.name) await this.assertNameFree(row.owner_user_id, body.name, id);
    await this.db
      .updateTable('agents')
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        updated_at: this.clock.now(),
      })
      .where('id', '=', id)
      .execute();
    if (body.status && body.status !== row.status) await this.coord?.publish(AUTH_REVOKED_CHANNEL, { agentId: id });
    this.audit.admin({ actorUserId: viewer.id, action: 'agent.update', targetType: 'agent', targetId: id, before: { name: row.name, description: row.description, status: row.status }, after: body });
    return this.get(id, viewer);
  }

  /** Soft delete: revokes keys and OAuth tokens; the name is freed for reuse. */
  async delete(id: string, viewer: UserSubject): Promise<void> {
    const row = await this.loadWritable(id, viewer);
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('agents').set({ status: 'deleted', name: `${row.name.slice(0, 60)} (deleted ${id.slice(-8)})`, updated_at: now }).where('id', '=', id).execute();
      await trx.updateTable('api_keys').set({ revoked_at: now }).where('agent_id', '=', id).where('revoked_at', 'is', null).execute();
      await trx.updateTable('oauth_tokens').set({ revoked_at: now }).where('agent_id', '=', id).where('revoked_at', 'is', null).execute();
      await trx.updateTable('oauth_consents').set({ revoked_at: now }).where('agent_id', '=', id).where('revoked_at', 'is', null).execute();
    });
    await this.coord?.publish(AUTH_REVOKED_CHANNEL, { agentId: id });
    this.audit.admin({ actorUserId: viewer.id, action: 'agent.delete', targetType: 'agent', targetId: id, before: { name: row.name } });
  }

  private keyStatus(k: { revoked_at: number | null; expires_at: number | null }): ApiKey['status'] {
    if (k.revoked_at !== null) return 'revoked';
    if (k.expires_at !== null && k.expires_at <= this.clock.now()) return 'expired';
    return 'active';
  }

  private toKey(k: { id: string; name: string; display_prefix: string; created_at: number; expires_at: number | null; last_used_at: number | null; revoked_at: number | null }): ApiKey {
    return { id: k.id, name: k.name, prefix: k.display_prefix, status: this.keyStatus(k), createdAt: toIso(k.created_at), expiresAt: toIsoOrNull(k.expires_at), lastUsedAt: toIsoOrNull(k.last_used_at), revokedAt: toIsoOrNull(k.revoked_at) };
  }

  async keys(id: string, viewer: UserSubject): Promise<{ items: ApiKey[] }> {
    await this.loadReadable(id, viewer);
    const rows = await this.db.selectFrom('api_keys').selectAll().where('agent_id', '=', id).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
    return { items: rows.map((r) => this.toKey(r)) };
  }

  async createKey(id: string, body: CreateApiKeyBody, viewer: UserSubject): Promise<CreateApiKeyResponse> {
    const agent = await this.loadWritable(id, viewer);
    if (agent.kind !== 'api') throw AppError.conflict('OAuth client agents authenticate with OAuth tokens, not API keys');
    const now = this.clock.now();
    const expiresAt = body.expiresAt === null ? null : fromIso(body.expiresAt);
    if (expiresAt !== null && expiresAt <= now) throw AppError.validation('Expiry must be in the future', [{ path: ['expiresAt'], message: 'Must be in the future', code: 'too_small' }]);
    const k = generateApiKey();
    const row = { id: newId(), agent_id: id, name: body.name, key_id: k.keyId, secret_hash: hashSecret(this.pepper, k.secret), display_prefix: k.displayPrefix, expires_at: expiresAt, last_used_at: null, last_used_ip: null, revoked_at: null, created_by: viewer.id, created_at: now };
    await this.db.insertInto('api_keys').values(row).execute();
    this.audit.admin({ actorUserId: viewer.id, action: 'api_key.create', targetType: 'agent', targetId: id, after: { keyId: row.id, name: body.name, prefix: k.displayPrefix, expiresAt: body.expiresAt } });
    return { key: this.toKey(row), secret: k.token };
  }

  async revokeKey(id: string, keyId: string, viewer: UserSubject): Promise<ApiKey> {
    await this.loadWritable(id, viewer);
    const row = await this.db.selectFrom('api_keys').selectAll().where('id', '=', keyId).where('agent_id', '=', id).executeTakeFirst();
    if (!row) throw AppError.notFound('API key');
    if (row.revoked_at === null) {
      row.revoked_at = this.clock.now();
      await this.db.updateTable('api_keys').set({ revoked_at: row.revoked_at }).where('id', '=', keyId).execute();
      await this.coord?.publish(AUTH_REVOKED_CHANNEL, { apiKeyId: keyId });
      this.audit.admin({ actorUserId: viewer.id, action: 'api_key.revoke', targetType: 'agent', targetId: id, before: { keyId, prefix: row.display_prefix } });
    }
    return this.toKey(row);
  }

  async revokeAll(id: string, viewer: UserSubject): Promise<{ revoked: number }> {
    if (!isAdmin(viewer)) throw AppError.forbidden();
    await this.loadReadable(id, viewer);
    const res = await this.db.updateTable('api_keys').set({ revoked_at: this.clock.now() }).where('agent_id', '=', id).where('revoked_at', 'is', null).executeTakeFirst();
    const revoked = Number(res.numUpdatedRows ?? 0);
    await this.coord?.publish(AUTH_REVOKED_CHANNEL, { agentId: id });
    this.audit.admin({ actorUserId: viewer.id, action: 'api_key.revoke_all', targetType: 'agent', targetId: id, after: { revoked } });
    return { revoked };
  }

  async getScope(id: string, viewer: UserSubject): Promise<AgentScope> {
    const a = await this.loadReadable(id, viewer);
    const grants = await this.db.selectFrom('grants').select(['target_type', 'target_id']).where('subject_type', '=', 'agent').where('subject_id', '=', id).where('effect', '=', 'allow').orderBy('target_id').execute();
    return {
      mode: toBool(a.narrowed) ? 'restricted' : 'inherit',
      serverIds: grants.filter((g) => g.target_type === 'server').map((g) => g.target_id),
      toolIds: grants.filter((g) => g.target_type === 'tool').map((g) => g.target_id),
    };
  }

  /** Stored as `agents.narrowed` + agent-subject allow grants; ids must be within the owner's own access. */
  async setScope(id: string, body: AgentScope, viewer: UserSubject): Promise<AgentScope> {
    const a = await this.loadWritable(id, viewer);
    const before = await this.getScope(id, viewer);
    const serverIds = [...new Set(body.serverIds)];
    const toolIds = [...new Set(body.toolIds)];
    if (body.mode === 'restricted') {
      const owner = await loadAclPrincipal(this.db, a.owner_user_id, null);
      const ex = await this.acl.explain(owner);
      const allowedTools = new Set(ex.filter((e) => e.decision.decision === 'allow').map((e) => e.tool.id));
      const allowedServers = new Set(ex.filter((e) => e.decision.decision === 'allow').map((e) => e.tool.serverId));
      const errors = [
        ...serverIds.map((s, i) => (allowedServers.has(s) ? null : { path: ['serverIds', String(i)], message: 'Outside the owner’s access', code: 'outside_owner_access' })),
        ...toolIds.map((t, i) => (allowedTools.has(t) ? null : { path: ['toolIds', String(i)], message: 'Outside the owner’s access', code: 'outside_owner_access' })),
      ].filter((e): e is NonNullable<typeof e> => e !== null);
      if (errors.length) throw AppError.validation(`${errors.length} id(s) are outside the owner’s access`, errors);
    }
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('agents').set({ narrowed: body.mode === 'restricted' ? 1 : 0, updated_at: now }).where('id', '=', id).execute();
      await trx.deleteFrom('grants').where('subject_type', '=', 'agent').where('subject_id', '=', id).where('effect', '=', 'allow').execute();
      if (body.mode === 'restricted') {
        const rows = [
          ...serverIds.map((t) => ({ target_type: 'server' as const, target_id: t })),
          ...toolIds.map((t) => ({ target_type: 'tool' as const, target_id: t })),
        ].map((r) => ({ id: newId(), subject_type: 'agent' as const, subject_id: id, ...r, effect: 'allow' as const, expires_at: null, source: 'manual' as const, access_request_id: null, conditions: null, note: 'agent scope', created_by: viewer.id, created_at: now }));
        if (rows.length) await trx.insertInto('grants').values(rows).execute();
      }
    });
    await this.acl.aclChanged();
    const after = await this.getScope(id, viewer);
    this.audit.admin({ actorUserId: viewer.id, action: 'agent.scope.update', targetType: 'agent', targetId: id, before, after });
    return after;
  }

  async access(id: string, viewer: UserSubject): Promise<AgentAccess> {
    const a = await this.loadReadable(id, viewer);
    const p = await loadAclPrincipal(this.db, a.owner_user_id, { id, narrowed: toBool(a.narrowed) });
    const ex = await this.acl.explain(p);
    const byServer = new Map<string, AgentAccess['servers'][number]>();
    for (const { tool, decision } of ex) {
      let s = byServer.get(tool.serverId);
      if (!s) byServer.set(tool.serverId, (s = { server: { id: tool.serverId, name: tool.serverName }, tools: [] }));
      s.tools.push({ tool: { id: tool.id, name: tool.upstreamName, qualifiedName: tool.exposedName }, decision: decision.decision });
    }
    return { servers: [...byServer.values()].sort((x, y) => x.server.name.localeCompare(y.server.name)) };
  }
}
