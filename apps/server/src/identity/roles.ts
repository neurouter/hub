import type { Kysely, Transaction } from 'kysely';
import type { Role, RoleSource } from '@neurouter/shared';
import type { MainDB } from '../db/schema.js';

type Db = Kysely<MainDB> | Transaction<MainDB>;

/**
 * Reconciles the roles of one source (local / oidc / bootstrap) to `target`; rows of other
 * sources are untouched. Returns what changed. A role held via two sources keeps the first row
 * (PK is user_id+role), so a source only removes rows it owns.
 */
export async function reconcileRoles(db: Db, userId: string, source: RoleSource, target: readonly Role[], now: number, by: string | null = null) {
  const rows = await db.selectFrom('user_roles').select(['role', 'source']).where('user_id', '=', userId).execute();
  const held = new Map(rows.map((r) => [r.role, r.source]));
  const want = new Set(target);
  const added: Role[] = [];
  const removed: Role[] = [];
  for (const role of want) {
    if (!held.has(role)) {
      await db.insertInto('user_roles').values({ user_id: userId, role, source, created_at: now, created_by: by }).execute();
      added.push(role);
    }
  }
  for (const [role, src] of held) {
    if (src === source && !want.has(role)) {
      await db.deleteFrom('user_roles').where('user_id', '=', userId).where('role', '=', role).execute();
      removed.push(role);
    }
  }
  return { added, removed };
}

/** Claim value matching shared by group and role mappings: string or string-array claim contains `value`. */
export function claimContains(claims: Record<string, unknown>, claim: string, value: string): boolean {
  const v = claims[claim];
  if (typeof v === 'string') return v === value;
  if (Array.isArray(v)) return v.some((x) => typeof x === 'string' && x === value);
  return false;
}

/** Roles granted by `{claim, value, role}` mappings for these claims (pure). */
export function rolesFromMappings(claims: Record<string, unknown>, mappings: readonly { claim: string; value: string; role: Role }[]): Role[] {
  const out = new Set<Role>();
  for (const m of mappings) if (claimContains(claims, m.claim, m.value)) out.add(m.role);
  return [...out].sort();
}
