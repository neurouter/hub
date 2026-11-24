import { globalCapabilities, isAdmin, type Capability } from '@neurouter/shared';
import type { UserSubject } from '../identity/principal.js';
import { AppError } from '../lib/errors.js';

/**
 * Forced scoping for audit, metrics and sessions (backend §14.1):
 * - Admin / Auditor: everything (an explicit `scope=me` narrows to the caller's own rows);
 * - Server Owner (not Admin/Auditor): `server_id IN ownedServerIds` forced; a `serverId`
 *   filter outside that set → 403; `scope=me` → the owner's own rows;
 * - plain user: `scope=me` forced whatever they pass.
 * Other filters (userId, agentId, toolId…) stay and are intersected with the forced scope.
 */
export interface ScopeFilters {
  serverId?: string | undefined;
  userId?: string | undefined;
  scope?: 'me' | undefined;
}

export interface ResolvedScope {
  mode: 'all' | 'owner' | 'me';
  /** Server restriction to apply (undefined = none). */
  serverIds?: string[];
  /** User restriction to apply (undefined = none). */
  userId?: string;
}

export function resolveScope(viewer: UserSubject, cap: Extract<Capability, 'audit:read' | 'audit:export' | 'metrics:read' | 'sessions:read'>, f: ScopeFilters): ResolvedScope {
  const global = isAdmin(viewer) || globalCapabilities(viewer.roles).has(cap);
  const serverIds = f.serverId ? [f.serverId] : undefined;
  if (global) {
    if (f.scope === 'me') return { mode: 'me', userId: viewer.id, ...(serverIds ? { serverIds } : {}) };
    return { mode: 'all', ...(serverIds ? { serverIds } : {}), ...(f.userId ? { userId: f.userId } : {}) };
  }
  const owner = viewer.ownedServerIds.length > 0;
  if (owner && f.scope !== 'me') {
    if (f.serverId && !viewer.ownedServerIds.includes(f.serverId)) throw AppError.forbidden('You can only view data for servers you own');
    return { mode: 'owner', serverIds: serverIds ?? [...viewer.ownedServerIds], ...(f.userId ? { userId: f.userId } : {}) };
  }
  if (cap === 'audit:export') throw AppError.forbidden();
  return { mode: 'me', userId: viewer.id, ...(serverIds ? { serverIds } : {}) };
}

/** Whether a single row (by its server and user) is visible under the scope. */
export function rowVisible(scope: ResolvedScope, row: { serverId: string | null; userId: string | null }): boolean {
  if (scope.serverIds && !(row.serverId !== null && scope.serverIds.includes(row.serverId))) return false;
  if (scope.userId && row.userId !== scope.userId) return false;
  return true;
}
