import * as z from 'zod';

/**
 * Stored roles (`user_roles.role`). "User" is implicit for every active account and
 * "Server Owner" is relational (`servers.owner_user_id`), so neither is stored.
 */
export const Role = z.enum(['admin', 'auditor']);
export type Role = z.infer<typeof Role>;

export const RoleSource = z.enum(['local', 'oidc', 'bootstrap']);
export type RoleSource = z.infer<typeof RoleSource>;

/** Display roles, derived from stored roles + ownership. Additive: everyone is a `user`. */
export const DisplayRole = z.enum(['admin', 'auditor', 'owner', 'user']);
export type DisplayRole = z.infer<typeof DisplayRole>;

export interface RoleSubject {
  roles: readonly Role[];
  ownedServerIds: readonly string[];
}

export function isAdmin(s: Pick<RoleSubject, 'roles'>): boolean {
  return s.roles.includes('admin');
}

export function isAuditor(s: Pick<RoleSubject, 'roles'>): boolean {
  return s.roles.includes('auditor');
}

export function isServerOwner(s: Pick<RoleSubject, 'ownedServerIds'>): boolean {
  return s.ownedServerIds.length > 0;
}

/** All display roles held, most privileged first. Always ends with `user`. */
export function displayRoles(s: RoleSubject): DisplayRole[] {
  const out: DisplayRole[] = [];
  if (isAdmin(s)) out.push('admin');
  if (isAuditor(s)) out.push('auditor');
  if (isServerOwner(s)) out.push('owner');
  out.push('user');
  return out;
}

/** The single most privileged display role (for layout decisions such as the landing page). */
export function primaryRole(s: RoleSubject): DisplayRole {
  return displayRoles(s)[0] ?? 'user';
}
