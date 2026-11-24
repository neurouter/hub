import { sql, type Kysely } from 'kysely';
import { isAdmin, type ListUsersQuery, type Role, type UserDetail, type UserRow, type CreateUserBody, type UpdateUserBody } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { toIso, toIsoOrNull } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { applyKeyset, containsCi, keysetPage, type KeysetSpec } from '../lib/keyset.js';
import { clampLimit } from '../lib/pagination.js';
import type { UserSubject } from './principal.js';
import { reconcileRoles } from './roles.js';

export const AUTH_REVOKED_CHANNEL = 'auth.revoked';

type UserBase = { id: string; email: string; name: string; avatar_url: string | null; status: 'active' | 'disabled'; last_login_at: number | null };

export class UsersService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly audit: AuditRecorder,
    private readonly coord?: CoordinationStore,
  ) {}

  private async decorate(users: UserBase[]): Promise<UserRow[]> {
    if (users.length === 0) return [];
    const ids = users.map((u) => u.id);
    const [roles, groups, agents] = await Promise.all([
      this.db.selectFrom('user_roles').select(['user_id', 'role']).where('user_id', 'in', ids).execute(),
      this.db.selectFrom('group_memberships as m').innerJoin('groups as g', 'g.id', 'm.group_id').select(['m.user_id', 'g.id', 'g.name', 'm.source']).where('m.user_id', 'in', ids).orderBy('g.name').execute(),
      this.db.selectFrom('agents').select(['owner_user_id', sql<number>`count(*)`.as('n')]).where('owner_user_id', 'in', ids).where('status', '!=', 'deleted').groupBy('owner_user_id').execute(),
    ]);
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatar_url,
      roles: (['admin', 'auditor'] as Role[]).filter((r) => roles.some((x) => x.user_id === u.id && x.role === r)),
      groups: groups.filter((g) => g.user_id === u.id).map((g) => ({ id: g.id, name: g.name, source: g.source })),
      status: u.status,
      lastLoginAt: toIsoOrNull(u.last_login_at),
      agentCount: Number(agents.find((a) => a.owner_user_id === u.id)?.n ?? 0),
    }));
  }

  async list(q: ListUsersQuery) {
    const limit = clampLimit(q.limit);
    let qb = this.db.selectFrom('users').select(['users.id', 'users.email', 'users.name', 'users.avatar_url', 'users.status', 'users.last_login_at']);
    if (q.q) qb = qb.where((eb) => eb.or([containsCi(eb.ref('users.email'), q.q!), containsCi(eb.ref('users.name'), q.q!)]));
    if (q.status) qb = qb.where('users.status', '=', q.status);
    if (q.role) qb = qb.where('users.id', 'in', this.db.selectFrom('user_roles').select('user_id').where('role', '=', q.role));
    if (q.groupId) qb = qb.where('users.id', 'in', this.db.selectFrom('group_memberships').select('user_id').where('group_id', '=', q.groupId));
    const sort = q.sort ?? 'name';
    const spec: KeysetSpec =
      sort === 'lastLoginAt'
        ? { sortExpr: sql<number>`coalesce(users.last_login_at, 0)`, idExpr: sql<string>`users.id`, order: q.order ?? 'desc', kind: 'number' }
        : { sortExpr: sql<string>`lower(${sql.ref(`users.${sort}`)})`, idExpr: sql<string>`users.id`, order: q.order ?? 'asc', kind: 'string' };
    const rows = await applyKeyset(qb, spec, q.cursor, limit).execute();
    const page = keysetPage(rows, limit, (r) => r, (r) => [sort === 'lastLoginAt' ? (r.last_login_at ?? 0) : (sort === 'email' ? r.email : r.name).toLowerCase(), r.id]);
    return { items: await this.decorate(page.items), nextCursor: page.nextCursor };
  }

  async detail(id: string, viewer: Pick<UserSubject, 'roles' | 'ownedServerIds'>): Promise<UserDetail> {
    const u = await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    if (!u) throw AppError.notFound('User');
    const [row] = await this.decorate([u]);
    const agents = await this.db.selectFrom('agents').select(['id', 'name']).where('owner_user_id', '=', id).where('status', '!=', 'deleted').orderBy('name').execute();
    return {
      ...row!,
      agents,
      oidcLinked: u.oidc_subject !== null,
      createdAt: toIso(u.created_at),
      actions: isAdmin(viewer) ? ['update_roles', u.status === 'active' ? 'disable' : 'enable'] : [],
    };
  }

  async create(body: CreateUserBody, actor: UserSubject): Promise<UserDetail> {
    const email = body.email.trim().toLowerCase();
    const exists = await this.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    if (exists) throw AppError.conflict('A user with this email already exists');
    const now = this.clock.now();
    const id = newId();
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('users').values({ id, email, name: body.name ?? email.split('@')[0]!, oidc_issuer: null, oidc_subject: null, avatar_url: null, last_login_at: null, created_at: now, updated_at: now }).execute();
      if (body.roles?.length) await reconcileRoles(trx, id, 'local', body.roles, now, actor.id);
    });
    this.audit.admin({ actorUserId: actor.id, action: 'user.create', targetType: 'user', targetId: id, after: { email, roles: body.roles ?? [] } });
    return this.detail(id, actor);
  }

  async update(id: string, body: UpdateUserBody, actor: UserSubject): Promise<UserDetail> {
    const u = await this.db.selectFrom('users').select(['id', 'status']).where('id', '=', id).executeTakeFirst();
    if (!u) throw AppError.notFound('User');
    if (id === actor.id && body.status === 'disabled') throw AppError.conflict('You cannot disable your own account');
    if (id === actor.id && body.roles && !body.roles.includes('admin') && actor.roles.includes('admin')) {
      const viaOther = await this.db.selectFrom('user_roles').select('source').where('user_id', '=', id).where('role', '=', 'admin').where('source', '!=', 'local').executeTakeFirst();
      if (!viaOther) throw AppError.conflict('You cannot remove your own admin role');
    }
    const now = this.clock.now();
    const before = await this.detail(id, actor);
    await this.db.transaction().execute(async (trx) => {
      if (body.roles) await reconcileRoles(trx, id, 'local', body.roles, now, actor.id);
      if (body.status && body.status !== u.status) {
        await trx.updateTable('users').set({ status: body.status, updated_at: now }).where('id', '=', id).execute();
        if (body.status === 'disabled') await this.killCredentials(trx, id, now);
      }
    });
    if (body.status === 'disabled') await this.coord?.publish(AUTH_REVOKED_CHANNEL, { userId: id });
    const after = await this.detail(id, actor);
    this.audit.admin({ actorUserId: actor.id, action: 'user.update', targetType: 'user', targetId: id, before: { roles: before.roles, status: before.status }, after: { roles: after.roles, status: after.status } });
    return after;
  }

  /** Disabling a user kills their web sessions and OAuth tokens; API keys stop working because the owner is inactive (frontend A9). */
  private async killCredentials(trx: Kysely<MainDB>, userId: string, now: number): Promise<void> {
    await trx.deleteFrom('web_sessions').where('user_id', '=', userId).execute();
    await trx.updateTable('oauth_tokens').set({ revoked_at: now }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
  }
}
