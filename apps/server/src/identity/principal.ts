import type { Kysely } from 'kysely';
import type { MembershipSource, Role } from '@neurouter/shared';
import type { MainDB } from '../db/schema.js';

/** A signed-in user with everything guards need (roles, groups, owned servers). */
export interface UserSubject {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  status: 'active' | 'disabled';
  roles: Role[];
  groups: { id: string; name: string; source: MembershipSource }[];
  ownedServerIds: string[];
  preferences: Record<string, unknown>;
}

const ROLE_ORDER: Role[] = ['admin', 'auditor'];

export async function loadUserSubject(db: Kysely<MainDB>, userId: string): Promise<UserSubject | null> {
  const user = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
  if (!user) return null;
  const [roles, groups, owned] = await Promise.all([
    db.selectFrom('user_roles').select('role').where('user_id', '=', userId).execute(),
    db
      .selectFrom('group_memberships as m')
      .innerJoin('groups as g', 'g.id', 'm.group_id')
      .select(['g.id', 'g.name', 'm.source'])
      .where('m.user_id', '=', userId)
      .orderBy('g.name')
      .execute(),
    db.selectFrom('servers').select('id').where('owner_user_id', '=', userId).where('status', '!=', 'disabled').orderBy('id').execute(),
  ]);
  const roleSet = new Set(roles.map((r) => r.role));
  let prefs: Record<string, unknown>;
  try {
    prefs = typeof user.preferences === 'string' ? (JSON.parse(user.preferences) as Record<string, unknown>) : ((user.preferences as unknown as Record<string, unknown>) ?? {});
  } catch {
    prefs = {};
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    status: user.status,
    roles: ROLE_ORDER.filter((r) => roleSet.has(r)),
    groups: groups.map((g) => ({ id: g.id, name: g.name, source: g.source })),
    ownedServerIds: owned.map((s) => s.id),
    preferences: prefs,
  };
}
