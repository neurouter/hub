import * as z from 'zod';
import { type Role, type RoleSubject, isAdmin } from './roles.js';

/** Capabilities (backend plan §14.1, frontend plan §3.1). Checked server-side; the UI only hides/disables. */
export const Capability = z.enum([
  'portal:use',
  'users:read',
  'users:write',
  'groups:read',
  'groups:write',
  'settings:read',
  'settings:write',
  'servers:read',
  'servers:write',
  'servers:create',
  'tools:read',
  'tools:write',
  'grants:read',
  'grants:write',
  'accessRequests:review',
  'approvals:review',
  'agents:readAll',
  'audit:read',
  'audit:export',
  'audit:verify',
  'metrics:read',
  'sessions:read',
]);
export type Capability = z.infer<typeof Capability>;

export const ALL_CAPABILITIES: readonly Capability[] = Capability.options;

/** Granted to every signed-in user. */
export const USER_CAPABILITIES: readonly Capability[] = ['portal:use'];

/** Global capabilities per stored role. Admin has everything. */
export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  admin: ALL_CAPABILITIES,
  auditor: [
    'portal:use',
    'users:read',
    'groups:read',
    'settings:read',
    'servers:read',
    'tools:read',
    'grants:read',
    'agents:readAll',
    'audit:read',
    'audit:export',
    'audit:verify',
    'metrics:read',
    'sessions:read',
  ],
};

/**
 * Capabilities a Server Owner holds, scoped to `ownedServerIds` only.
 * `servers:create` is Admin-only (A2); audit verify is chain-wide so it stays Auditor/Admin.
 */
export const OWNER_SCOPED_CAPABILITIES: readonly Capability[] = [
  'servers:read',
  'servers:write',
  'tools:read',
  'tools:write',
  'grants:read',
  'grants:write',
  'accessRequests:review',
  'approvals:review',
  'audit:read',
  'audit:export',
  'metrics:read',
  'sessions:read',
];

/** Capabilities granted globally (not resource-scoped) by the stored roles. */
export function globalCapabilities(roles: readonly Role[]): Set<Capability> {
  const caps = new Set<Capability>(USER_CAPABILITIES);
  for (const role of roles) for (const c of ROLE_CAPABILITIES[role]) caps.add(c);
  return caps;
}

/**
 * The full capability list for `/api/me.capabilities`: global capabilities plus the
 * owner-scoped ones when the user owns at least one server. Sorted in enum order.
 */
export function capabilitiesFor(subject: RoleSubject): Capability[] {
  const caps = globalCapabilities(subject.roles);
  if (subject.ownedServerIds.length > 0) for (const c of OWNER_SCOPED_CAPABILITIES) caps.add(c);
  return ALL_CAPABILITIES.filter((c) => caps.has(c));
}

export interface CapabilityResource {
  /** The server the resource belongs to (a server, or a tool/grant/approval on it). */
  serverId?: string | null;
}

/**
 * Shared permission check used by server guards and the web `can()`.
 * - Admin: always true.
 * - Global role capability: true for any resource.
 * - Owner-scoped capability: true when no resource is given (area access), or when the
 *   resource's server is owned by the subject.
 */
export function can(subject: RoleSubject, cap: Capability, resource?: CapabilityResource): boolean {
  if (isAdmin(subject)) return true;
  if (globalCapabilities(subject.roles).has(cap)) return true;
  if (subject.ownedServerIds.length === 0 || !OWNER_SCOPED_CAPABILITIES.includes(cap)) return false;
  if (!resource || resource.serverId === undefined) return true;
  if (resource.serverId === null) return false;
  return subject.ownedServerIds.includes(resource.serverId);
}

export function canAny(subject: RoleSubject, caps: readonly Capability[], resource?: CapabilityResource): boolean {
  return caps.some((c) => can(subject, c, resource));
}

/** True when the subject's access to `cap` is limited to owned servers (UI shows "owned" / "my servers"). */
export function isOwnerScoped(subject: RoleSubject, cap: Capability): boolean {
  return !isAdmin(subject) && !globalCapabilities(subject.roles).has(cap) && can(subject, cap);
}

/** True when the subject may read `cap`'s area but holds no write capability for it (Auditor "read-only"). */
export function isReadOnly(subject: RoleSubject, read: Capability, write: Capability): boolean {
  return can(subject, read) && !can(subject, write);
}
