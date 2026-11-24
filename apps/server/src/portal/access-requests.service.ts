import { sql, type Kysely, type SelectQueryBuilder, type SqlBool } from 'kysely';
import { can, isAdmin, isAuditor, type AccessRequest, type ApproveAccessRequestBody, type CreateAccessRequestBody, type Grant, type ListAccessRequestsQuery, type ListMyAccessRequestsQuery } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { MainDB } from '../db/schema.js';
import type { UserSubject } from '../identity/principal.js';
import { fromIso, toIso, toIsoOrNull, type Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination.js';
import { loadAclPrincipal, type AclService } from '../policy/acl-cache.js';
import type { GrantsService } from '../policy/grants.service.js';

type Row = {
  id: string;
  requester_user_id: string;
  agent_id: string | null;
  target_type: 'server' | 'tool';
  target_id: string;
  server_id: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  grant_id: string | null;
  created_at: number;
};

const NAMELESS = '(deleted)';

/**
 * Access requests (§14.3, decision 12): a user asks for a server or tool → the server's owner
 * (or an Admin) approves, which creates a grant (source `access_request`) and invalidates ACL
 * snapshots on every replica, so the agent can call immediately; or denies with a note.
 */
export class AccessRequestsService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly grants: GrantsService,
    private readonly acl: AclService,
    private readonly audit: AuditRecorder,
  ) {}

  private async toApi(rows: Row[]): Promise<AccessRequest[]> {
    if (!rows.length) return [];
    const ids = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
    const [users, agents, servers, tools] = await Promise.all([
      this.db.selectFrom('users').select(['id', 'name', 'email']).where('id', 'in', ids(rows.flatMap((r) => [r.requester_user_id, r.decided_by]))).execute(),
      this.db.selectFrom('agents').select(['id', 'name']).where('id', 'in', ids(rows.map((r) => r.agent_id))).execute(),
      this.db.selectFrom('servers').select(['id', 'name']).where('id', 'in', ids(rows.map((r) => r.server_id))).execute(),
      this.db.selectFrom('tools').select(['id', 'exposed_name']).where('id', 'in', ids(rows.filter((r) => r.target_type === 'tool').map((r) => r.target_id))).execute(),
    ]);
    const user = (id: string) => {
      const u = users.find((x) => x.id === id);
      return { id, name: u ? u.name || u.email : NAMELESS };
    };
    const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? NAMELESS;
    return rows.map((r) => ({
      id: r.id,
      requester: user(r.requester_user_id),
      agent: r.agent_id ? { id: r.agent_id, name: agents.find((a) => a.id === r.agent_id)?.name ?? NAMELESS } : null,
      target: {
        type: r.target_type,
        id: r.target_id,
        name: r.target_type === 'server' ? serverName(r.target_id) : (tools.find((t) => t.id === r.target_id)?.exposed_name ?? NAMELESS),
        server: { id: r.server_id, name: serverName(r.server_id) },
      },
      reason: r.reason,
      status: r.status,
      reviewer: r.decided_by ? user(r.decided_by) : null,
      note: r.decision_note,
      createdAt: toIso(Number(r.created_at)),
      decidedAt: toIsoOrNull(r.decided_at),
      grantId: r.grant_id,
    }));
  }

  private async one(id: string): Promise<Row> {
    const r = (await this.db.selectFrom('access_requests').selectAll().where('id', '=', id).executeTakeFirst()) as Row | undefined;
    if (!r) throw AppError.notFound('Access request');
    return r;
  }

  /** Resolves a target to its server; only requestable (visible) servers/tools qualify. */
  private async resolveTarget(target: { type: 'server' | 'tool'; id: string }): Promise<string> {
    if (target.type === 'server') {
      const s = await this.db.selectFrom('servers').select(['id']).where('id', '=', target.id).where('enabled', '=', 1).where('status', '!=', 'disabled').executeTakeFirst();
      if (!s) throw AppError.validation('Unknown target', [{ path: ['target', 'id'], message: 'Server not found', code: 'not_found' }]);
      return s.id;
    }
    const t = await this.db
      .selectFrom('tools as t')
      .innerJoin('servers as s', 's.id', 't.server_id')
      .select(['t.server_id'])
      .where('t.id', '=', target.id)
      .where('t.status', '=', 'active')
      .where('t.enabled', '=', 1)
      .where('s.enabled', '=', 1)
      .where('s.status', '!=', 'disabled')
      .executeTakeFirst();
    if (!t) throw AppError.validation('Unknown target', [{ path: ['target', 'id'], message: 'Tool not found', code: 'not_found' }]);
    return t.server_id;
  }

  async create(body: CreateAccessRequestBody, viewer: UserSubject): Promise<AccessRequest> {
    const serverId = await this.resolveTarget(body.target);
    if (body.agentId) {
      const a = await this.db.selectFrom('agents').select('id').where('id', '=', body.agentId).where('owner_user_id', '=', viewer.id).where('status', '!=', 'deleted').executeTakeFirst();
      if (!a) throw AppError.validation('Unknown agent', [{ path: ['agentId'], message: 'Agent not found', code: 'not_found' }]);
    }
    let dup = this.db
      .selectFrom('access_requests')
      .select('id')
      .where('requester_user_id', '=', viewer.id)
      .where('target_type', '=', body.target.type)
      .where('target_id', '=', body.target.id)
      .where('status', '=', 'pending');
    dup = body.agentId ? dup.where('agent_id', '=', body.agentId) : dup.where('agent_id', 'is', null);
    if (await dup.executeTakeFirst()) throw AppError.conflict('You already have a pending request for this');
    // already allowed? (user principal; a server request counts when every visible tool is allowed)
    const p = await loadAclPrincipal(this.db, viewer.id, null);
    const decisions = await this.acl.explain(p, body.target.type === 'tool' ? { toolId: body.target.id } : { serverId });
    const visible = decisions.filter((d) => d.tool.status === 'active' && d.tool.enabled);
    if (visible.length && visible.every((d) => d.decision.decision === 'allow')) throw AppError.conflict('You already have access');
    const row: Row = {
      id: newId(),
      requester_user_id: viewer.id,
      agent_id: body.agentId ?? null,
      target_type: body.target.type,
      target_id: body.target.id,
      server_id: serverId,
      reason: body.reason,
      status: 'pending',
      decided_by: null,
      decided_at: null,
      decision_note: null,
      grant_id: null,
      created_at: this.clock.now(),
    };
    await this.db.insertInto('access_requests').values({ ...row, requested_duration_days: null }).execute();
    const [out] = await this.toApi([row]);
    this.audit.admin({ actorUserId: viewer.id, action: 'access_request.create', targetType: 'access_request', targetId: row.id, serverId, after: out });
    return out!;
  }

  async listMine(q: ListMyAccessRequestsQuery, viewer: UserSubject): Promise<{ items: AccessRequest[]; nextCursor: string | null }> {
    let qb = this.db.selectFrom('access_requests').selectAll().where('requester_user_id', '=', viewer.id);
    if (q.status) qb = qb.where('status', '=', q.status);
    return this.page(qb, q, 'desc');
  }

  async cancelMine(id: string, viewer: UserSubject): Promise<void> {
    const r = await this.one(id);
    if (r.requester_user_id !== viewer.id) throw AppError.notFound('Access request');
    if (r.status !== 'pending') throw AppError.conflict(`This request was already ${r.status}`);
    const res = await this.db.updateTable('access_requests').set({ status: 'cancelled', decided_at: this.clock.now(), decided_by: viewer.id }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    if (!Number(res.numUpdatedRows)) throw AppError.conflict('This request was already decided');
    this.audit.admin({ actorUserId: viewer.id, action: 'access_request.cancel', targetType: 'access_request', targetId: id, serverId: r.server_id });
  }

  /** Review queue: owners see their servers, Admins/Auditors everything. Default pending, oldest first. */
  async list(q: ListAccessRequestsQuery, viewer: UserSubject): Promise<{ items: AccessRequest[]; nextCursor: string | null }> {
    const global = isAdmin(viewer) || isAuditor(viewer);
    if (!global && !viewer.ownedServerIds.length) throw AppError.forbidden();
    if (q.serverId && !global && !viewer.ownedServerIds.includes(q.serverId)) throw AppError.forbidden('You can only review requests for servers you own');
    const status = q.status ?? 'pending';
    let qb = this.db.selectFrom('access_requests').selectAll();
    qb = status === 'resolved' ? qb.where('status', '!=', 'pending') : qb.where('status', '=', status);
    if (!global) qb = qb.where(sql<SqlBool>`server_id in (${sql.join(viewer.ownedServerIds)})`);
    if (q.serverId) qb = qb.where('server_id', '=', q.serverId);
    return this.page(qb, q, status === 'pending' ? 'asc' : 'desc');
  }

  private async page<O>(qb: SelectQueryBuilder<MainDB, 'access_requests', O>, q: { cursor?: string | undefined; limit?: number | undefined }, order: 'asc' | 'desc'): Promise<{ items: AccessRequest[]; nextCursor: string | null }> {
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    let x = qb;
    if (key) {
      const [ts, id] = key;
      if (typeof ts !== 'number' || typeof id !== 'string') throw AppError.validation('Invalid cursor', [{ path: ['cursor'], message: 'Invalid cursor', code: 'invalid_cursor' }]);
      const op = order === 'asc' ? ('>' as const) : ('<' as const);
      x = x.where((eb) => eb.or([eb('created_at', op, ts), eb.and([eb('created_at', '=', ts), eb('id', op, id)])]));
    }
    const rows = (await x.orderBy('created_at', order).orderBy('id', order).limit(limit + 1).execute()) as unknown as Row[];
    const slice = rows.slice(0, limit);
    const last = slice[slice.length - 1];
    return { items: await this.toApi(slice), nextCursor: rows.length > limit && last ? encodeCursor([Number(last.created_at), last.id]) : null };
  }

  private reviewable(r: Row, viewer: UserSubject): void {
    if (!can(viewer, 'accessRequests:review', { serverId: r.server_id })) {
      throw isAdmin(viewer) || isAuditor(viewer) || viewer.ownedServerIds.length ? AppError.forbidden() : AppError.notFound('Access request');
    }
    if (r.status !== 'pending') throw AppError.conflict(`This request was already ${r.status}`);
  }

  async approve(id: string, body: ApproveAccessRequestBody, viewer: UserSubject): Promise<{ request: AccessRequest; grant: Grant }> {
    const r = await this.one(id);
    this.reviewable(r, viewer);
    const subject = body.grantSubject ?? { type: 'user' as const, id: r.requester_user_id };
    let target: { type: 'server' | 'tool'; id: string } = { type: r.target_type, id: r.target_id };
    if (body.target) {
      // may narrow server → one of its tools; never widen or move to another server
      const same = body.target.type === r.target_type && body.target.id === r.target_id;
      if (!same) {
        const tool = body.target.type === 'tool' && r.target_type === 'server' ? await this.db.selectFrom('tools').select('server_id').where('id', '=', body.target.id).executeTakeFirst() : null;
        if (!tool || tool.server_id !== r.server_id) throw AppError.validation('The grant target can only narrow the request to one of its tools', [{ path: ['target'], message: 'Must be the requested target or one of its tools', code: 'invalid_target' }]);
      }
      target = body.target;
    }
    if (body.expiresAt && fromIso(body.expiresAt) <= this.clock.now()) throw AppError.validation('Expiry must be in the future', [{ path: ['expiresAt'], message: 'Must be in the future', code: 'too_small' }]);
    // claim the request first (CAS on status) so two reviewers can't both approve
    const now = this.clock.now();
    const claimed = await this.db.updateTable('access_requests').set({ status: 'approved', decided_by: viewer.id, decided_at: now, decision_note: body.note ?? null }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    if (!Number(claimed.numUpdatedRows)) throw AppError.conflict('This request was already decided');
    let grant: Grant;
    try {
      grant = await this.grants.create({ subject, target, effect: 'allow', ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}) }, viewer, { accessRequestId: id, reuseExisting: true });
    } catch (err) {
      await this.db.updateTable('access_requests').set({ status: 'pending', decided_by: null, decided_at: null, decision_note: null }).where('id', '=', id).execute();
      throw err;
    }
    await this.db.updateTable('access_requests').set({ grant_id: grant.id }).where('id', '=', id).execute();
    await this.acl.aclChanged();
    const [request] = await this.toApi([await this.one(id)]);
    this.audit.admin({ actorUserId: viewer.id, action: 'access_request.approve', targetType: 'access_request', targetId: id, serverId: r.server_id, after: { request, grantId: grant.id } });
    return { request: request!, grant };
  }

  async deny(id: string, note: string, viewer: UserSubject): Promise<AccessRequest> {
    const r = await this.one(id);
    this.reviewable(r, viewer);
    const res = await this.db.updateTable('access_requests').set({ status: 'denied', decided_by: viewer.id, decided_at: this.clock.now(), decision_note: note }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    if (!Number(res.numUpdatedRows)) throw AppError.conflict('This request was already decided');
    const [request] = await this.toApi([await this.one(id)]);
    this.audit.admin({ actorUserId: viewer.id, action: 'access_request.deny', targetType: 'access_request', targetId: id, serverId: r.server_id, after: request });
    return request!;
  }

  /** Retention: prune decided requests older than the cutoff. */
  async prune(cutoff: number): Promise<number> {
    const res = await this.db.deleteFrom('access_requests').where('status', '!=', 'pending').where('created_at', '<', cutoff).executeTakeFirst();
    return Number(res.numDeletedRows);
  }
}
