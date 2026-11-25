import { sql, type Kysely } from 'kysely';
import { EVERYONE_GROUP_ID, can, type AddMembersBody, type ClaimMapping, type CreateClaimMappingBody, type CreateGroupBody, type GroupDetail, type GroupListItem, type GroupMember, type GroupRow, type ListGroupsQuery, type ListMembersQuery, type UpdateGroupBody } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { toIso, toIsoOrNull } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { applyKeyset, containsCi, keysetPage } from '../lib/keyset.js';
import { clampLimit } from '../lib/pagination.js';
import type { UserSubject } from './principal.js';

export const ACL_CHANGED_CHANNEL = 'acl.changed';

export class GroupsService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly audit: AuditRecorder,
    private readonly onAclChange: () => Promise<void> = async () => {},
  ) {}

  private async rows(ids: string[]): Promise<Map<string, GroupRow>> {
    const out = new Map<string, GroupRow>();
    if (!ids.length) return out;
    const [groups, members, mappings, grants] = await Promise.all([
      this.db.selectFrom('groups').selectAll().where('id', 'in', ids).execute(),
      this.db.selectFrom('group_memberships').select(['group_id', sql<number>`count(*)`.as('n')]).where('group_id', 'in', ids).groupBy('group_id').execute(),
      this.db.selectFrom('group_claim_mappings').select(['group_id', sql<number>`count(*)`.as('n')]).where('group_id', 'in', ids).groupBy('group_id').execute(),
      this.db.selectFrom('grants').select(['subject_id', sql<number>`count(*)`.as('n')]).where('subject_type', '=', 'group').where('subject_id', 'in', ids).groupBy('subject_id').execute(),
    ]);
    const everyone = ids.includes(EVERYONE_GROUP_ID) ? Number((await this.db.selectFrom('users').select(sql<number>`count(*)`.as('n')).where('status', '=', 'active').executeTakeFirst())?.n ?? 0) : 0;
    for (const g of groups) {
      const builtin = g.id === EVERYONE_GROUP_ID;
      out.set(g.id, {
        id: g.id,
        name: g.name,
        description: g.description,
        source: g.source,
        memberCount: builtin ? everyone : Number(members.find((m) => m.group_id === g.id)?.n ?? 0),
        mappingCount: Number(mappings.find((m) => m.group_id === g.id)?.n ?? 0),
        grantCount: Number(grants.find((m) => m.subject_id === g.id)?.n ?? 0),
        ...(builtin ? { builtin: true } : {}),
      });
    }
    return out;
  }

  /** Users get `{id, name}` only (pickers); auditors/admins get full rows. */
  async list(q: ListGroupsQuery, viewer: UserSubject): Promise<{ items: GroupListItem[]; nextCursor: string | null }> {
    const limit = clampLimit(q.limit);
    let qb = this.db.selectFrom('groups').select(['groups.id', 'groups.name']);
    if (q.q) qb = qb.where((eb) => containsCi(eb.ref('groups.name'), q.q!));
    if (q.source) qb = qb.where('groups.source', '=', q.source);
    const rows = await applyKeyset(qb, { sortExpr: sql<string>`lower(groups.name)`, idExpr: sql<string>`groups.id`, order: 'asc', kind: 'string' }, q.cursor, limit).execute();
    const page = keysetPage(rows, limit, (r) => r, (r) => [r.name.toLowerCase(), r.id]);
    if (!can(viewer, 'groups:read')) return { items: page.items.map((r) => ({ id: r.id, name: r.name })), nextCursor: page.nextCursor };
    const full = await this.rows(page.items.map((r) => r.id));
    return { items: page.items.map((r) => full.get(r.id)!), nextCursor: page.nextCursor };
  }

  async row(id: string): Promise<GroupRow> {
    const r = (await this.rows([id])).get(id);
    if (!r) throw AppError.notFound('Group');
    return r;
  }

  async detail(id: string, viewer: UserSubject): Promise<GroupDetail> {
    const row = await this.row(id);
    const g = await this.db.selectFrom('groups').select(['created_at', 'updated_at']).where('id', '=', id).executeTakeFirstOrThrow();
    return { ...row, createdAt: toIso(g.created_at), updatedAt: toIso(g.updated_at), actions: can(viewer, 'groups:write') && id !== EVERYONE_GROUP_ID ? ['update', 'delete', 'manage_members', 'manage_mappings'] : [] };
  }

  async create(body: CreateGroupBody, actor: UserSubject): Promise<GroupRow> {
    await this.assertNameFree(body.name);
    const now = this.clock.now();
    const id = newId();
    await this.db.insertInto('groups').values({ id, name: body.name, description: body.description ?? '', source: 'local', created_at: now, updated_at: now }).execute();
    this.audit.admin({ actorUserId: actor.id, action: 'group.create', targetType: 'group', targetId: id, after: body });
    return this.row(id);
  }

  private assertEditable(id: string): void {
    if (id === EVERYONE_GROUP_ID) throw AppError.conflict('Everyone is a built-in group: every user is a member, and it cannot be changed');
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    let q = this.db.selectFrom('groups').select('id').where(sql<boolean>`lower(name) = ${name.toLowerCase()}`);
    if (exceptId) q = q.where('id', '!=', exceptId);
    if (await q.executeTakeFirst()) throw AppError.conflict('A group with this name already exists');
  }

  async update(id: string, body: UpdateGroupBody, actor: UserSubject): Promise<GroupRow> {
    this.assertEditable(id);
    const before = await this.row(id);
    if (body.name !== undefined) await this.assertNameFree(body.name, id);
    await this.db
      .updateTable('groups')
      .set({ ...(body.name !== undefined ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}), updated_at: this.clock.now() })
      .where('id', '=', id)
      .execute();
    const after = await this.row(id);
    this.audit.admin({ actorUserId: actor.id, action: 'group.update', targetType: 'group', targetId: id, before: { name: before.name, description: before.description }, after: { name: after.name, description: after.description } });
    return after;
  }

  async delete(id: string, actor: UserSubject): Promise<void> {
    this.assertEditable(id);
    const before = await this.row(id);
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('grants').where('subject_type', '=', 'group').where('subject_id', '=', id).execute();
      await trx.deleteFrom('groups').where('id', '=', id).execute();
    });
    this.audit.admin({ actorUserId: actor.id, action: 'group.delete', targetType: 'group', targetId: id, before });
    await this.onAclChange();
  }

  async members(id: string, q: ListMembersQuery): Promise<{ items: GroupMember[]; nextCursor: string | null }> {
    await this.row(id);
    const limit = clampLimit(q.limit);
    let qb = this.db
      .selectFrom('group_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.name', 'u.email', 'm.source', 'm.created_at'])
      .where('m.group_id', '=', id);
    if (q.q) qb = qb.where((eb) => eb.or([containsCi(eb.ref('u.email'), q.q!), containsCi(eb.ref('u.name'), q.q!)]));
    const rows = await applyKeyset(qb, { sortExpr: sql<string>`lower(u.name)`, idExpr: sql<string>`u.id`, order: 'asc', kind: 'string' }, q.cursor, limit).execute();
    return keysetPage(
      rows,
      limit,
      (r) => ({ user: { id: r.id, name: r.name, email: r.email }, source: r.source, addedAt: toIso(r.created_at) }),
      (r) => [r.name.toLowerCase(), r.id],
    );
  }

  async addMembers(id: string, body: AddMembersBody, actor: UserSubject): Promise<{ added: number }> {
    this.assertEditable(id);
    await this.row(id);
    const users = await this.db.selectFrom('users').select('id').where('id', 'in', body.userIds).execute();
    const missing = body.userIds.filter((u) => !users.some((x) => x.id === u));
    if (missing.length) throw AppError.validation('Unknown users', missing.map((m) => ({ path: ['userIds', String(body.userIds.indexOf(m))], message: 'User not found', code: 'not_found' })));
    const existing = await this.db.selectFrom('group_memberships').select('user_id').where('group_id', '=', id).where('user_id', 'in', body.userIds).execute();
    const toAdd = [...new Set(body.userIds)].filter((u) => !existing.some((e) => e.user_id === u));
    const now = this.clock.now();
    if (toAdd.length) await this.db.insertInto('group_memberships').values(toAdd.map((user_id) => ({ group_id: id, user_id, source: 'local' as const, created_at: now }))).execute();
    this.audit.admin({ actorUserId: actor.id, action: 'group.members.add', targetType: 'group', targetId: id, after: { userIds: toAdd } });
    if (toAdd.length) await this.onAclChange();
    return { added: toAdd.length };
  }

  async removeMember(id: string, userId: string, actor: UserSubject): Promise<void> {
    const m = await this.db.selectFrom('group_memberships').select('source').where('group_id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (!m) throw AppError.notFound('Membership');
    if (m.source === 'oidc') throw AppError.conflict('OIDC memberships are reconciled at login; change the claim mapping or the IdP group instead');
    await this.db.deleteFrom('group_memberships').where('group_id', '=', id).where('user_id', '=', userId).execute();
    this.audit.admin({ actorUserId: actor.id, action: 'group.members.remove', targetType: 'group', targetId: id, before: { userId } });
    await this.onAclChange();
  }

  async mappings(id: string): Promise<{ items: ClaimMapping[] }> {
    await this.row(id);
    const rows = await this.db.selectFrom('group_claim_mappings').selectAll().where('group_id', '=', id).orderBy('claim').orderBy('value').execute();
    return { items: rows.map((r) => ({ id: r.id, claim: r.claim, value: r.value, lastSeenAt: toIsoOrNull(r.last_seen_at) })) };
  }

  async createMapping(id: string, body: CreateClaimMappingBody, actor: UserSubject): Promise<ClaimMapping> {
    this.assertEditable(id);
    await this.row(id);
    const dup = await this.db.selectFrom('group_claim_mappings').select('id').where('group_id', '=', id).where('claim', '=', body.claim).where('value', '=', body.value).executeTakeFirst();
    if (dup) throw AppError.conflict('This mapping already exists');
    const mid = newId();
    await this.db.insertInto('group_claim_mappings').values({ id: mid, group_id: id, claim: body.claim, value: body.value, last_seen_at: null, created_by: actor.id, created_at: this.clock.now() }).execute();
    this.audit.admin({ actorUserId: actor.id, action: 'group.mapping.create', targetType: 'group', targetId: id, after: body });
    return { id: mid, claim: body.claim, value: body.value, lastSeenAt: null };
  }

  async deleteMapping(id: string, mappingId: string, actor: UserSubject): Promise<void> {
    const res = await this.db.deleteFrom('group_claim_mappings').where('id', '=', mappingId).where('group_id', '=', id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw AppError.notFound('Claim mapping');
    this.audit.admin({ actorUserId: actor.id, action: 'group.mapping.delete', targetType: 'group', targetId: id, before: { mappingId } });
  }
}
