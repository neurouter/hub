import { EVERYONE_GROUP_ID } from '@neurouter/shared';
import type { Kysely } from 'kysely';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { toBool } from '../lib/json.js';
import { allowedToolIds, evaluateTool, relevantSubjects, type AclGrant, type AclPrincipal, type AclTool, type ToolDecision } from './acl.js';

export const ACL_CHANGED = 'acl.changed';
export const CATALOG_CHANGED = 'catalog.changed';

export interface CatalogTool extends AclTool {
  exposedName: string;
  upstreamName: string;
  serverSlug: string;
  serverName: string;
}

interface Snapshot {
  at: number;
  allowed: Set<string>;
}

/**
 * Effective-permission snapshots per (user, agent) with a 30 s TTL, invalidated on
 * `acl.changed` / `catalog.changed` from any replica (backend §5.3).
 */
export class AclService {
  private catalog: { at: number; tools: CatalogTool[] } | null = null;
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly coord?: CoordinationStore,
    private readonly ttlMs = 30_000,
  ) {
    coord?.subscribe(ACL_CHANGED, () => this.snapshots.clear());
    coord?.subscribe(CATALOG_CHANGED, () => {
      this.catalog = null;
      this.snapshots.clear();
    });
    coord?.subscribe('resync', () => this.invalidateLocal());
  }

  invalidateLocal(): void {
    this.catalog = null;
    this.snapshots.clear();
  }

  async aclChanged(): Promise<void> {
    this.snapshots.clear();
    await this.coord?.publish(ACL_CHANGED, {});
  }

  async catalogChanged(): Promise<void> {
    this.invalidateLocal();
    await this.coord?.publish(CATALOG_CHANGED, {});
  }

  /** Every non-removed tool with its server state (deleted servers excluded). */
  async tools(): Promise<CatalogTool[]> {
    const now = this.clock.now();
    if (this.catalog && now - this.catalog.at < this.ttlMs) return this.catalog.tools;
    const rows = await this.db
      .selectFrom('tools as t')
      .innerJoin('servers as s', 's.id', 't.server_id')
      .select(['t.id', 't.server_id', 't.status', 't.enabled', 't.exposed_name', 't.upstream_name', 's.slug', 's.name as server_name', 's.enabled as server_enabled', 's.status as server_status'])
      .where('t.status', '!=', 'removed')
      .orderBy('t.exposed_name')
      .execute();
    const tools = rows.map((r) => ({
      id: r.id,
      serverId: r.server_id,
      status: r.status,
      enabled: toBool(r.enabled),
      serverEnabled: toBool(r.server_enabled),
      serverStatus: r.server_status,
      exposedName: r.exposed_name,
      upstreamName: r.upstream_name,
      serverSlug: r.slug,
      serverName: r.server_name,
    }));
    this.catalog = { at: now, tools };
    return tools;
  }

  async grantsFor(p: AclPrincipal): Promise<AclGrant[]> {
    const subjects = relevantSubjects(p);
    const rows = await this.db
      .selectFrom('grants')
      .select(['id', 'subject_type', 'subject_id', 'target_type', 'target_id', 'effect', 'expires_at'])
      .where((eb) => eb.or(subjects.map((s) => eb.and([eb('subject_type', '=', s.type), eb('subject_id', '=', s.id)]))))
      .execute();
    return rows.map((r) => ({ id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, targetType: r.target_type, targetId: r.target_id, effect: r.effect, expiresAt: r.expires_at }));
  }

  private key(p: AclPrincipal): string {
    return `${p.userId}:${p.agent?.id ?? '-'}:${p.agent?.narrowed ? 1 : 0}:${[...p.groupIds].sort().join(',')}`;
  }

  async allowed(p: AclPrincipal): Promise<Set<string>> {
    const now = this.clock.now();
    const k = this.key(p);
    const hit = this.snapshots.get(k);
    if (hit && now - hit.at < this.ttlMs) return hit.allowed;
    const [tools, grants] = await Promise.all([this.tools(), this.grantsFor(p)]);
    const allowed = allowedToolIds(p, tools, grants, now);
    if (this.snapshots.size > 5000) this.snapshots.clear();
    this.snapshots.set(k, { at: now, allowed });
    return allowed;
  }

  /** Per-tool explanation (backs /api/grants/effective and /api/agents/:id/access). */
  async explain(p: AclPrincipal, filter: { serverId?: string; toolId?: string } = {}): Promise<{ tool: CatalogTool; decision: ToolDecision }[]> {
    const now = this.clock.now();
    const [tools, grants] = await Promise.all([this.tools(), this.grantsFor(p)]);
    return tools
      .filter((t) => (!filter.serverId || t.serverId === filter.serverId) && (!filter.toolId || t.id === filter.toolId))
      .map((tool) => ({ tool, decision: evaluateTool(p, tool, grants, now) }));
  }
}

/** Loads the ACL principal for a user (and optionally one of their agents). */
export async function loadAclPrincipal(db: Kysely<MainDB>, userId: string, agent: { id: string; narrowed: boolean } | null): Promise<AclPrincipal> {
  const groups = await db.selectFrom('group_memberships').select('group_id').where('user_id', '=', userId).execute();
  return { userId, groupIds: [EVERYONE_GROUP_ID, ...groups.map((g) => g.group_id)], agent };
}
