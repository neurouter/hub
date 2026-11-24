import type { Kysely } from 'kysely';
import { can, isAdmin, isAuditor, type LookupNames } from '@neurouter/shared';
import type { MainDB } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { UserSubject } from './principal.js';

export const MAX_LOOKUP_IDS = 100;

/** Catalog visibility for plain users; injected so the rule stays the catalog's. */
export interface VisibleServers {
  visibleServerIds(viewer: UserSubject): Promise<Set<string>>;
}

/**
 * Batch id → display name for filter chips (the URL keeps ids only, so a reload or shared link
 * would otherwise show a bare id). Returns only what the viewer could already see elsewhere:
 * - users: with users:read (admin/auditor), or yourself
 * - groups: any signed-in user (group pickers already list names to everyone)
 * - agents: with agents:readAll, or your own
 * - servers and tools: admin/auditor; otherwise servers you own or see in the catalog
 */
export class NameLookupService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly catalog: VisibleServers,
  ) {}

  async names(ids: readonly string[] | undefined, viewer: UserSubject): Promise<LookupNames> {
    const want = [...new Set(ids ?? [])];
    if (want.length > MAX_LOOKUP_IDS) throw AppError.validation(`At most ${MAX_LOOKUP_IDS} ids per lookup`, [{ path: ['ids'], message: `At most ${MAX_LOOKUP_IDS} ids`, code: 'too_big' }]);
    const names: LookupNames['names'] = {};
    if (!want.length) return { names };
    const [users, groups, agents, servers, tools] = await Promise.all([
      this.db.selectFrom('users').select(['id', 'name', 'email']).where('id', 'in', want).execute(),
      this.db.selectFrom('groups').select(['id', 'name']).where('id', 'in', want).execute(),
      this.db.selectFrom('agents').select(['id', 'name', 'owner_user_id']).where('id', 'in', want).execute(),
      this.db.selectFrom('servers').select(['id', 'name']).where('id', 'in', want).execute(),
      this.db.selectFrom('tools').select(['id', 'exposed_name', 'server_id']).where('id', 'in', want).execute(),
    ]);
    const global = isAdmin(viewer) || isAuditor(viewer);
    let catalog: Set<string> | null = null;
    const serverVisible = async (id: string) => {
      if (global || viewer.ownedServerIds.includes(id)) return true;
      catalog ??= await this.catalog.visibleServerIds(viewer);
      return catalog.has(id);
    };
    for (const u of users) if (can(viewer, 'users:read') || u.id === viewer.id) names[u.id] = { type: 'user', name: u.name || u.email };
    for (const g of groups) names[g.id] = { type: 'group', name: g.name };
    for (const a of agents) if (can(viewer, 'agents:readAll') || a.owner_user_id === viewer.id) names[a.id] = { type: 'agent', name: a.name };
    for (const s of servers) if (await serverVisible(s.id)) names[s.id] = { type: 'server', name: s.name };
    for (const t of tools) if (await serverVisible(t.server_id)) names[t.id] = { type: 'tool', name: t.exposed_name };
    return { names };
  }
}
