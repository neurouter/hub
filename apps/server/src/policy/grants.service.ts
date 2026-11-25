import { sql, type Kysely, type SqlBool } from 'kysely';
import { EVERYONE_GROUP_ID, can, isAdmin, isAuditor, type BatchGrantsBody, type CreateGrantBody, type EffectiveAccess, type EffectiveAccessQuery, type Grant, type ListGrantsQuery, type ProblemFieldError } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { fromIso, toIso, toIsoOrNull } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { toBool } from '../lib/json.js';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination.js';
import type { UserSubject } from '../identity/principal.js';
import { loadAclPrincipal, type AclService } from './acl-cache.js';
import type { AclGrant } from './acl.js';

type GrantDb = { id: string; subject_type: 'user' | 'group' | 'agent'; subject_id: string; target_type: 'server' | 'tool'; target_id: string; effect: 'allow' | 'deny'; expires_at: number | null; source: 'manual' | 'access_request'; access_request_id: string | null; created_by: string; created_at: number };

const globalReader = (v: UserSubject) => isAdmin(v) || isAuditor(v);
const isEveryone = (r: { subject_type: string; subject_id: string }) => r.subject_type === 'group' && r.subject_id === EVERYONE_GROUP_ID;

/** Grants (backend §5.3, §14.3): owners manage grants on their servers; deny wins at evaluation. */
export class GrantsService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly acl: AclService,
    private readonly audit: AuditRecorder,
  ) {}

  /** Server id of a target (404 when it doesn't exist). */
  private async serverOf(target: { type: 'server' | 'tool'; id: string }): Promise<string> {
    if (target.type === 'server') {
      const s = await this.db.selectFrom('servers').select('id').where('id', '=', target.id).executeTakeFirst();
      if (!s) throw AppError.validation('Unknown target', [{ path: ['target', 'id'], message: 'Server not found', code: 'not_found' }]);
      return s.id;
    }
    const t = await this.db.selectFrom('tools').select('server_id').where('id', '=', target.id).executeTakeFirst();
    if (!t) throw AppError.validation('Unknown target', [{ path: ['target', 'id'], message: 'Tool not found', code: 'not_found' }]);
    return t.server_id;
  }

  private async subjectExists(s: { type: 'user' | 'group' | 'agent'; id: string }): Promise<boolean> {
    const table = s.type === 'user' ? 'users' : s.type === 'group' ? 'groups' : 'agents';
    const r = await this.db.selectFrom(table).select('id').where('id', '=', s.id).executeTakeFirst();
    return !!r;
  }

  private async toApi(rows: GrantDb[]): Promise<Grant[]> {
    if (!rows.length) return [];
    const ids = (t: string, k: 'subject' | 'target') => [...new Set(rows.filter((r) => (k === 'subject' ? r.subject_type : r.target_type) === t).map((r) => (k === 'subject' ? r.subject_id : r.target_id)))];
    const [users, groups, agents, servers, tools, creators] = await Promise.all([
      this.db.selectFrom('users').select(['id', 'name']).where('id', 'in', ids('user', 'subject')).execute(),
      this.db.selectFrom('groups').select(['id', 'name']).where('id', 'in', ids('group', 'subject')).execute(),
      this.db.selectFrom('agents').select(['id', 'name']).where('id', 'in', ids('agent', 'subject')).execute(),
      this.db.selectFrom('servers').select(['id', 'name']).execute(),
      this.db.selectFrom('tools').select(['id', 'exposed_name', 'server_id']).where('id', 'in', ids('tool', 'target')).execute(),
      this.db.selectFrom('users').select(['id', 'name']).where('id', 'in', [...new Set(rows.map((r) => r.created_by))]).execute(),
    ]);
    const nameOf = (list: { id: string; name: string }[], id: string) => list.find((x) => x.id === id)?.name ?? '(deleted)';
    return rows.map((r) => {
      const tool = r.target_type === 'tool' ? tools.find((t) => t.id === r.target_id) : undefined;
      const serverId = r.target_type === 'server' ? r.target_id : (tool?.server_id ?? '');
      return {
        id: r.id,
        subject: { type: r.subject_type, id: r.subject_id, name: nameOf(r.subject_type === 'user' ? users : r.subject_type === 'group' ? groups : agents, r.subject_id) },
        target: { type: r.target_type, id: r.target_id, name: r.target_type === 'server' ? nameOf(servers, r.target_id) : (tool?.exposed_name ?? '(deleted)'), server: { id: serverId, name: nameOf(servers, serverId) } },
        effect: r.effect,
        source: r.source,
        accessRequestId: r.access_request_id,
        createdBy: { id: r.created_by, name: nameOf(creators, r.created_by) },
        createdAt: toIso(r.created_at),
        expiresAt: toIsoOrNull(r.expires_at),
      };
    });
  }

  /** Server-id expression of a grant row (server targets and the server of tool targets). */
  private targetServer() {
    return sql<string>`case when g.target_type = 'server' then g.target_id else (select t.server_id from tools t where t.id = g.target_id) end`;
  }

  async list(q: ListGrantsQuery, viewer: UserSubject): Promise<{ items: Grant[]; nextCursor: string | null }> {
    const limit = clampLimit(q.limit);
    let qb = this.db.selectFrom('grants as g').selectAll('g');
    if (!globalReader(viewer)) {
      const own = sql<SqlBool>`(g.subject_type = 'user' and g.subject_id = ${viewer.id}) or (g.subject_type = 'agent' and g.subject_id in (select id from agents where owner_user_id = ${viewer.id}))`;
      qb = qb.where(viewer.ownedServerIds.length ? sql<SqlBool>`(${this.targetServer()} in (${sql.join(viewer.ownedServerIds)}) or ${own})` : own);
    }
    if (q.subjectType) qb = qb.where('g.subject_type', '=', q.subjectType);
    if (q.subjectId) qb = qb.where('g.subject_id', '=', q.subjectId);
    if (q.toolId) qb = qb.where('g.target_type', '=', 'tool').where('g.target_id', '=', q.toolId);
    if (q.serverId) qb = qb.where(sql<SqlBool>`${this.targetServer()} = ${q.serverId}`);
    if (q.effect) qb = qb.where('g.effect', '=', q.effect);
    const key = decodeCursor(q.cursor);
    if (key) qb = qb.where((eb) => eb.or([eb('g.created_at', '<', key[0] as number), eb.and([eb('g.created_at', '=', key[0] as number), eb('g.id', '<', key[1] as string)])]));
    const rows = (await qb.orderBy('g.created_at', 'desc').orderBy('g.id', 'desc').limit(limit + 1).execute()) as GrantDb[];
    const slice = rows.slice(0, limit);
    const last = slice[slice.length - 1];
    return { items: await this.toApi(slice), nextCursor: rows.length > limit && last ? encodeCursor([last.created_at, last.id]) : null };
  }

  private async validate(body: CreateGrantBody, viewer: UserSubject, path: string[] = []): Promise<{ serverId: string; expiresAt: number | null } | ProblemFieldError> {
    let serverId: string;
    try {
      serverId = await this.serverOf(body.target);
    } catch {
      return { path: [...path, 'target', 'id'], message: 'Target not found', code: 'not_found' };
    }
    if (!can(viewer, 'grants:write', { serverId })) return { path: [...path, 'target'], message: 'You do not manage this server', code: 'forbidden' };
    if (body.subject.type === 'group' && body.subject.id === EVERYONE_GROUP_ID && !isAdmin(viewer)) return { path: [...path, 'subject'], message: 'Only admins can grant access to Everyone', code: 'forbidden' };
    if (!(await this.subjectExists(body.subject))) return { path: [...path, 'subject', 'id'], message: 'Subject not found', code: 'not_found' };
    const expiresAt = body.expiresAt ? fromIso(body.expiresAt) : null;
    if (expiresAt !== null && expiresAt <= this.clock.now()) return { path: [...path, 'expiresAt'], message: 'Must be in the future', code: 'too_small' };
    return { serverId, expiresAt };
  }

  async create(body: CreateGrantBody, viewer: UserSubject, opts: { accessRequestId?: string; reuseExisting?: boolean } = {}): Promise<Grant> {
    const v = await this.validate(body, viewer);
    if ('path' in v) {
      if (v.code === 'forbidden') throw AppError.forbidden(v.message);
      throw AppError.validation(v.message, [v]);
    }
    const dup = await this.db
      .selectFrom('grants')
      .select('id')
      .where('subject_type', '=', body.subject.type)
      .where('subject_id', '=', body.subject.id)
      .where('target_type', '=', body.target.type)
      .where('target_id', '=', body.target.id)
      .where('effect', '=', body.effect)
      .executeTakeFirst();
    if (dup && opts.reuseExisting) {
      const existing = (await this.db.selectFrom('grants').selectAll().where('id', '=', dup.id).executeTakeFirst()) as GrantDb;
      return (await this.toApi([existing]))[0]!;
    }
    if (dup) throw AppError.conflict('This grant already exists');
    const row: GrantDb = { id: newId(), subject_type: body.subject.type, subject_id: body.subject.id, target_type: body.target.type, target_id: body.target.id, effect: body.effect, expires_at: v.expiresAt, source: opts.accessRequestId ? 'access_request' : 'manual', access_request_id: opts.accessRequestId ?? null, created_by: viewer.id, created_at: this.clock.now() };
    await this.db.insertInto('grants').values({ ...row, conditions: null, note: null }).execute();
    await this.acl.aclChanged();
    const [g] = await this.toApi([row]);
    this.audit.admin({ actorUserId: viewer.id, action: 'grant.create', targetType: 'grant', targetId: row.id, serverId: v.serverId, after: g });
    return g!;
  }

  async delete(id: string, viewer: UserSubject): Promise<void> {
    const row = (await this.db.selectFrom('grants').selectAll().where('id', '=', id).executeTakeFirst()) as GrantDb | undefined;
    if (!row) throw AppError.notFound('Grant');
    const serverId = await this.serverOf({ type: row.target_type, id: row.target_id }).catch(() => null);
    if (!can(viewer, 'grants:write', { serverId: serverId ?? null })) throw globalReader(viewer) || viewer.ownedServerIds.length ? AppError.forbidden() : AppError.notFound('Grant');
    if (isEveryone(row) && !isAdmin(viewer)) throw AppError.forbidden('Only admins can change access for Everyone');
    const [before] = await this.toApi([row]);
    await this.db.deleteFrom('grants').where('id', '=', id).execute();
    await this.acl.aclChanged();
    this.audit.admin({ actorUserId: viewer.id, action: 'grant.delete', targetType: 'grant', targetId: id, serverId: serverId ?? null, before });
  }

  /** One transaction, all or nothing; 422 lists every offending entry. */
  async batch(body: BatchGrantsBody, viewer: UserSubject): Promise<{ created: number; updated: number; deleted: number }> {
    if (!can(viewer, 'grants:write')) throw AppError.forbidden();
    const errors: ProblemFieldError[] = [];
    const plans: { body: CreateGrantBody; expiresAt: number | null; serverId: string }[] = [];
    for (const [i, u] of body.upserts.entries()) {
      const v = await this.validate(u, viewer, ['upserts', String(i)]);
      if ('path' in v) errors.push(v);
      else plans.push({ body: u, expiresAt: v.expiresAt, serverId: v.serverId });
    }
    const deleteServer = new Map<string, string | null>();
    const delRows = body.deletes.length ? ((await this.db.selectFrom('grants').selectAll().where('id', 'in', body.deletes).execute()) as GrantDb[]) : [];
    for (const [i, id] of body.deletes.entries()) {
      const r = delRows.find((x) => x.id === id);
      const sid = r ? await this.serverOf({ type: r.target_type, id: r.target_id }).catch(() => null) : null;
      deleteServer.set(id, sid);
      if (!r) errors.push({ path: ['deletes', String(i)], message: 'Grant not found', code: 'not_found' });
      else if (!can(viewer, 'grants:write', { serverId: sid })) errors.push({ path: ['deletes', String(i)], message: 'You do not manage this server', code: 'forbidden' });
      else if (isEveryone(r) && !isAdmin(viewer)) errors.push({ path: ['deletes', String(i)], message: 'Only admins can change access for Everyone', code: 'forbidden' });
    }
    if (errors.length) throw AppError.validation(`${errors.length} entr${errors.length === 1 ? 'y is' : 'ies are'} invalid`, errors);
    const now = this.clock.now();
    const out = { created: 0, updated: 0, deleted: 0 };
    await this.db.transaction().execute(async (trx) => {
      for (const p of plans) {
        const b = p.body;
        const cur = await trx.selectFrom('grants').select('id').where('subject_type', '=', b.subject.type).where('subject_id', '=', b.subject.id).where('target_type', '=', b.target.type).where('target_id', '=', b.target.id).where('effect', '=', b.effect).executeTakeFirst();
        if (cur) {
          await trx.updateTable('grants').set({ expires_at: p.expiresAt }).where('id', '=', cur.id).execute();
          out.updated++;
        } else {
          await trx
            .insertInto('grants')
            .values({ id: newId(), subject_type: b.subject.type, subject_id: b.subject.id, target_type: b.target.type, target_id: b.target.id, effect: b.effect, expires_at: p.expiresAt, source: 'manual', access_request_id: null, conditions: null, note: null, created_by: viewer.id, created_at: now })
            .execute();
          out.created++;
        }
      }
      if (body.deletes.length) out.deleted = Number((await trx.deleteFrom('grants').where('id', 'in', body.deletes).executeTakeFirst()).numDeletedRows ?? 0);
    });
    await this.acl.aclChanged();
    // one event per affected server, so each server's owners see the changes to their server
    const byServer = new Map<string | null, { upserts: CreateGrantBody[]; deletes: string[] }>();
    const slot = (sid: string | null) => byServer.get(sid) ?? byServer.set(sid, { upserts: [], deletes: [] }).get(sid)!;
    for (const p of plans) slot(p.serverId).upserts.push(p.body);
    for (const id of body.deletes) slot(deleteServer.get(id) ?? null).deletes.push(id);
    if (byServer.size === 0) slot(null);
    for (const [serverId, part] of byServer) {
      this.audit.admin({ actorUserId: viewer.id, action: 'grant.batch', targetType: 'grant', targetId: null, serverId, after: { ...part, batch: out } });
    }
    return out;
  }

  /** `acl.explain` for a user or agent (backend §5.3). */
  async effective(q: EffectiveAccessQuery, viewer: UserSubject): Promise<EffectiveAccess> {
    let userId: string;
    let agent: { id: string; narrowed: boolean } | null = null;
    if (q.subjectType === 'user') {
      userId = q.subjectId;
      if (!(await this.db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst())) throw AppError.notFound('User');
    } else {
      const a = await this.db.selectFrom('agents').select(['id', 'owner_user_id', 'narrowed']).where('id', '=', q.subjectId).where('status', '!=', 'deleted').executeTakeFirst();
      if (!a) throw AppError.notFound('Agent');
      userId = a.owner_user_id;
      agent = { id: a.id, narrowed: toBool(a.narrowed) };
    }
    const self = userId === viewer.id;
    if (!self && !globalReader(viewer) && !viewer.ownedServerIds.length) throw AppError.forbidden();
    const ownedOnly = !self && !globalReader(viewer);
    if (ownedOnly && q.serverId && !viewer.ownedServerIds.includes(q.serverId)) throw AppError.forbidden();
    const principal = await loadAclPrincipal(this.db, userId, agent);
    let ex = await this.acl.explain(principal, { ...(q.serverId ? { serverId: q.serverId } : {}), ...(q.toolId ? { toolId: q.toolId } : {}) });
    if (ownedOnly) ex = ex.filter((e) => viewer.ownedServerIds.includes(e.tool.serverId));
    const grantIds = new Set<string>();
    const grants: AclGrant[] = [];
    for (const e of ex) {
      for (const m of e.decision.matches) {
        if (grantIds.has(m.grant.id)) continue;
        grantIds.add(m.grant.id);
        grants.push(m.grant);
      }
    }
    const apiGrants = await this.toApi(
      grants.length ? ((await this.db.selectFrom('grants').selectAll().where('id', 'in', [...grantIds]).execute()) as GrantDb[]) : [],
    );
    const byId = new Map(apiGrants.map((g) => [g.id, g]));
    const perTool = ex.map(({ tool, decision }) => ({
      toolId: tool.id,
      qualifiedName: tool.exposedName,
      decision: decision.decision,
      inherited: decision.inherited,
      via: decision.matches
        .filter((m) => byId.has(m.grant.id))
        .map((m) => ({
          kind: (m.grant.subjectType === 'group' ? 'group' : agent && m.role === 'owner_allow' && !agent.narrowed ? 'owner' : m.grant.targetType === 'server' ? 'server' : 'direct') as 'group' | 'owner' | 'server' | 'direct',
          grantId: m.grant.id,
          subject: byId.get(m.grant.id)!.subject,
        })),
    }));
    const decisions = perTool.map((p) => p.decision);
    const decision = q.toolId ? (decisions[0] ?? 'none') : decisions.includes('allow') ? 'allow' : decisions.includes('deny') ? 'deny' : 'none';
    return { decision, reasons: apiGrants.map((g) => ({ grantId: g.id, subject: g.subject, target: g.target, effect: g.effect })), perTool };
  }
}
