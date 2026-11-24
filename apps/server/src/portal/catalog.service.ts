import type { Kysely } from 'kysely';
import type {
  CatalogConnection,
  CatalogServer,
  CatalogServerAccess,
  CatalogServerDetail,
  CatalogTags,
  CatalogTool,
  CatalogToolAccess,
  ListCatalogServersQuery,
  ListCatalogToolsQuery,
  ServerAuthType,
} from '@neurouter/shared';
import type { MainDB } from '../db/schema.js';
import type { UserSubject } from '../identity/principal.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { parseJsonColumn, toBool } from '../lib/json.js';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination.js';
import { loadAclPrincipal, type AclService } from '../policy/acl-cache.js';
import { evaluateTool, type AclGrant, type AclPrincipal } from '../policy/acl.js';
import type { ToolSearchService } from '../search/search.service.js';
import { suggestQuery } from '../search/suggest.js';
import type { SettingsService } from '../settings/settings.service.js';
import { iconPath } from '../catalog/icons.js';

interface ServerRec {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  ownerId: string;
  ownerName: string;
  health: CatalogServer['health']['status'];
  authType: ServerAuthType;
  icon: { etag: string | null } | undefined;
}

interface ToolRec {
  id: string;
  serverId: string;
  name: string;
  qualifiedName: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresApproval: boolean;
  rateLimit: { perMinute: number; burst: number } | null;
}

interface View {
  servers: ServerRec[];
  tools: ToolRec[];
  toolAccess: Map<string, CatalogToolAccess>;
  serverAccess: Map<string, CatalogServerAccess>;
  connections: Map<string, CatalogConnection>;
}

/**
 * Portal catalog (§14.3 "Portal"): servers and tools a user can see, with per-user access
 * computed by the same ACL evaluator as the gateway (user principal, no agent narrowing) plus
 * pending access requests. Only active, enabled tools on enabled servers are shown; with
 * `catalogVisibility='granted'` only servers with some access are listed.
 */
export class PortalCatalogService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly acl: AclService,
    private readonly settings: SettingsService,
    private readonly search: ToolSearchService,
  ) {}

  /** Access state of a server from its visible tools (or a server grant when it has none). */
  static serverAccess(toolStates: CatalogToolAccess[], serverGrant: 'allow' | 'deny' | 'none', pending: boolean): CatalogServerAccess {
    const allowed = toolStates.filter((s) => s === 'allowed').length;
    if (toolStates.length && allowed === toolStates.length) return 'granted';
    if (allowed > 0) return 'partial';
    if (!toolStates.length && serverGrant === 'allow') return 'granted';
    return pending ? 'pending' : 'none';
  }

  private async view(viewer: UserSubject): Promise<View> {
    const now = this.clock.now();
    const servers = await this.db
      .selectFrom('servers as s')
      .innerJoin('users as u', 'u.id', 's.owner_user_id')
      .leftJoin('server_health as h', 'h.server_id', 's.id')
      .select(['s.id', 's.slug', 's.name', 's.description', 's.tags', 's.owner_user_id', 'u.name as owner_name', 'h.status as health', 's.auth_mode'])
      .where('s.enabled', '=', 1)
      .where('s.status', '!=', 'disabled')
      .execute();
    const ids = servers.map((s) => s.id);
    const [creds, icons, tools, pendingReqs, tokens, principal] = await Promise.all([
      ids.length ? this.db.selectFrom('server_credentials').select(['server_id', 'kind']).where('server_id', 'in', ids).execute() : [],
      ids.length ? this.db.selectFrom('server_icons').select(['server_id', 'etag']).where('server_id', 'in', ids).where('error', 'is', null).execute() : [],
      ids.length
        ? this.db
            .selectFrom('tools')
            .select(['id', 'server_id', 'upstream_name', 'exposed_name', 'title', 'description', 'input_schema', 'requires_approval', 'rate_limit'])
            .where('server_id', 'in', ids)
            .where('status', '=', 'active')
            .where('enabled', '=', 1)
            .orderBy('exposed_name')
            .execute()
        : [],
      this.db.selectFrom('access_requests').select(['target_type', 'target_id', 'server_id']).where('requester_user_id', '=', viewer.id).where('status', '=', 'pending').execute(),
      this.db.selectFrom('user_upstream_tokens').select(['server_id', 'status', 'expires_at', 'refresh_ct']).where('user_id', '=', viewer.id).execute(),
      loadAclPrincipal(this.db, viewer.id, null),
    ]);
    const grants = await this.acl.grantsFor(principal);
    const serverRecs: ServerRec[] = servers.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      description: s.description ?? '',
      tags: parseJsonColumn<string[]>(s.tags) ?? [],
      ownerId: s.owner_user_id,
      ownerName: s.owner_name,
      health: (s.health ?? 'unknown') as CatalogServer['health']['status'],
      authType: s.auth_mode === 'none' ? 'none' : s.auth_mode === 'user_oauth' ? 'per_user_oauth' : creds.some((c) => c.server_id === s.id && c.kind === 'shared_header') ? 'shared_header' : 'shared_bearer',
      icon: icons.find((i) => i.server_id === s.id),
    }));
    const toolRecs: ToolRec[] = tools.map((t) => ({
      id: t.id,
      serverId: t.server_id,
      name: t.upstream_name,
      qualifiedName: t.exposed_name,
      title: t.title,
      description: t.description ?? '',
      inputSchema: parseJsonColumn<Record<string, unknown>>(t.input_schema) ?? { type: 'object' },
      requiresApproval: toBool(t.requires_approval),
      rateLimit: parseJsonColumn<{ perMinute: number; burst: number }>(t.rate_limit),
    }));
    const pendingTool = new Set(pendingReqs.filter((r) => r.target_type === 'tool').map((r) => r.target_id));
    const pendingServer = new Set(pendingReqs.map((r) => r.server_id));
    const toolAccess = new Map<string, CatalogToolAccess>();
    for (const t of toolRecs) {
      const d = evaluateTool(principal, { id: t.id, serverId: t.serverId, status: 'active', enabled: true, serverEnabled: true, serverStatus: 'active' }, grants, now);
      const pendingReq = pendingTool.has(t.id) || pendingReqs.some((r) => r.target_type === 'server' && r.target_id === t.serverId);
      toolAccess.set(t.id, d.decision === 'allow' ? 'allowed' : d.decision === 'deny' ? 'denied' : pendingReq ? 'pending' : 'none');
    }
    const serverAccess = new Map<string, CatalogServerAccess>();
    for (const s of serverRecs) {
      const states = toolRecs.filter((t) => t.serverId === s.id).map((t) => toolAccess.get(t.id)!);
      serverAccess.set(s.id, PortalCatalogService.serverAccess(states, serverGrantDecision(principal, s.id, grants, now), pendingServer.has(s.id)));
    }
    const connections = new Map<string, CatalogConnection>();
    for (const s of serverRecs) {
      if (s.authType !== 'per_user_oauth') {
        connections.set(s.id, 'not_required');
        continue;
      }
      const tok = tokens.find((x) => x.server_id === s.id);
      connections.set(s.id, connectionState(tok ?? null, now));
    }
    return { servers: serverRecs, tools: toolRecs, toolAccess, serverAccess, connections };
  }

  private toServer(s: ServerRec, v: View): CatalogServer {
    return {
      id: s.id,
      slug: s.slug,
      name: s.name,
      description: s.description,
      iconUrl: iconPath(s.id, s.icon),
      tags: s.tags,
      owner: { id: s.ownerId, name: s.ownerName },
      toolCount: v.tools.filter((t) => t.serverId === s.id).length,
      access: v.serverAccess.get(s.id) ?? 'none',
      health: { status: s.health },
      authType: s.authType,
      connection: v.connections.get(s.id) ?? 'not_required',
    };
  }

  private async visibleServers(v: View): Promise<ServerRec[]> {
    const vis = await this.settings.get('catalogVisibility');
    return vis === 'granted' ? v.servers.filter((s) => ['granted', 'partial'].includes(v.serverAccess.get(s.id) ?? 'none')) : v.servers;
  }

  async servers(q: ListCatalogServersQuery, viewer: UserSubject): Promise<{ items: CatalogServer[]; nextCursor: string | null }> {
    const v = await this.view(viewer);
    let list = (await this.visibleServers(v)).map((s) => this.toServer(s, v));
    if (q.q) {
      const needle = q.q.toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(needle) || s.slug.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle) || s.tags.some((t) => t.toLowerCase().includes(needle)));
    }
    if (q.tag?.length) list = list.filter((s) => q.tag!.every((t) => s.tags.includes(t)));
    if (q.access === 'granted') list = list.filter((s) => s.access === 'granted' || s.access === 'partial');
    if (q.access === 'requestable') list = list.filter((s) => s.access !== 'granted');
    const sort = q.sort ?? 'name';
    const desc = sort === 'toolCount';
    const key = (s: CatalogServer): string | number => (sort === 'toolCount' ? s.toolCount : s.name.toLowerCase());
    const cmp = (a: CatalogServer, b: CatalogServer) => {
      const ka = key(a);
      const kb = key(b);
      const c = ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      return desc ? -c : c;
    };
    list.sort(cmp);
    return pageAfter(list, q.cursor, clampLimit(q.limit), (s) => [key(s), s.id], desc);
  }

  async server(id: string, viewer: UserSubject): Promise<CatalogServerDetail> {
    const v = await this.view(viewer);
    const s = (await this.visibleServers(v)).find((x) => x.id === id);
    if (!s) throw AppError.notFound('Server');
    return {
      ...this.toServer(s, v),
      tools: v.tools
        .filter((t) => t.serverId === id)
        .map((t) => ({ id: t.id, name: t.name, qualifiedName: t.qualifiedName, title: t.title, description: t.description, inputSchema: t.inputSchema, access: v.toolAccess.get(t.id) ?? 'none', requiresApproval: t.requiresApproval, rateLimit: t.rateLimit })),
    };
  }

  async tools(q: ListCatalogToolsQuery, viewer: UserSubject): Promise<{ items: CatalogTool[]; nextCursor: string | null; suggestion?: string | null }> {
    const v = await this.view(viewer);
    const servers = new Map((await this.visibleServers(v)).map((s) => [s.id, s]));
    let pool = v.tools.filter((t) => servers.has(t.serverId) && (!q.serverId || t.serverId === q.serverId));
    if (q.access === 'granted') pool = pool.filter((t) => v.toolAccess.get(t.id) === 'allowed');
    if (q.access === 'requestable') pool = pool.filter((t) => v.toolAccess.get(t.id) !== 'allowed');
    const limit = clampLimit(q.limit);
    const toItem = (t: ToolRec, score: number | null): CatalogTool => ({
      id: t.id,
      qualifiedName: t.qualifiedName,
      title: t.title,
      description: t.description,
      server: { id: t.serverId, name: servers.get(t.serverId)!.name },
      access: v.toolAccess.get(t.id) ?? 'none',
      requiresApproval: t.requiresApproval,
      score,
    });
    if (q.q) {
      // ranking pool = tools the user may see (catalog visibility); access is computed per tool
      const res = await this.search.search({ query: q.q, limit: 200, includeSchemas: false }, new Set(pool.map((t) => t.id)));
      const byName = new Map(pool.map((t) => [t.qualifiedName, t]));
      const ranked = res.tools.map((r) => ({ t: byName.get(r.name)!, score: r.score ?? null })).filter((r) => r.t);
      const start = offsetCursor(q.cursor);
      const page = ranked.slice(start, start + limit);
      // "Did you mean": only for an empty first page, from the words of the tools in the pool
      const suggestion = !ranked.length && start === 0 ? suggestQuery(q.q, pool.flatMap((t) => [t.qualifiedName, t.title ?? '', t.description, servers.get(t.serverId)!.name])) : null;
      return { items: page.map((r) => toItem(r.t, r.score)), nextCursor: start + limit < ranked.length ? encodeCursor([start + limit]) : null, suggestion };
    }
    const cmp = (a: ToolRec, b: ToolRec) => (a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : a.id < b.id ? -1 : 1);
    pool.sort(cmp);
    const page = pageAfter(pool, q.cursor, limit, (t) => [t.qualifiedName, t.id]);
    return { items: page.items.map((t) => toItem(t, null)), nextCursor: page.nextCursor };
  }

  /** Ids of the servers this viewer sees in the catalog (honours the catalogVisibility setting). */
  async visibleServerIds(viewer: UserSubject): Promise<Set<string>> {
    return new Set((await this.visibleServers(await this.view(viewer))).map((s) => s.id));
  }

  async tags(viewer: UserSubject): Promise<CatalogTags> {
    const v = await this.view(viewer);
    const counts = new Map<string, number>();
    for (const s of await this.visibleServers(v)) for (const t of s.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return { tags: [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) };
  }
}

function serverGrantDecision(p: AclPrincipal, serverId: string, grants: AclGrant[], now: number): 'allow' | 'deny' | 'none' {
  return evaluateTool(p, { id: '\u0000server-only', serverId, status: 'active', enabled: true, serverEnabled: true, serverStatus: 'active' }, grants, now).decision;
}

export function connectionState(tok: { status: string; expires_at: number | null; refresh_ct: unknown } | null, now: number): CatalogConnection {
  if (!tok || tok.status === 'revoked') return 'not_connected';
  if (tok.status === 'refresh_failed') return 'expired';
  if (tok.expires_at !== null && Number(tok.expires_at) <= now && !tok.refresh_ct) return 'expired';
  return 'connected';
}

function offsetCursor(cursor: string | undefined): number {
  const k = decodeCursor(cursor);
  if (!k) return 0;
  const n = k[0];
  if (typeof n !== 'number' || n < 0 || !Number.isInteger(n)) throw AppError.validation('Invalid cursor', [{ path: ['cursor'], message: 'Invalid cursor', code: 'invalid_cursor' }]);
  return n;
}

/** Keyset paging over an in-memory list sorted by (key, id) in `desc` or ascending order. */
export function pageAfter<T>(sorted: T[], cursor: string | undefined, limit: number, keyOf: (t: T) => [string | number, string], desc = false): { items: T[]; nextCursor: string | null } {
  const k = decodeCursor(cursor);
  let start = 0;
  if (k) {
    if (k.length !== 2 || typeof k[1] !== 'string') throw AppError.validation('Invalid cursor', [{ path: ['cursor'], message: 'Invalid cursor', code: 'invalid_cursor' }]);
    const ck = k[0] as string | number;
    const cid = k[1];
    start = sorted.findIndex((t) => {
      const [a, id] = keyOf(t);
      const c = a < ck ? -1 : a > ck ? 1 : id < cid ? -1 : id > cid ? 1 : 0;
      return desc ? c < 0 : c > 0;
    });
    if (start < 0) start = sorted.length;
  }
  const items = sorted.slice(start, start + limit);
  const last = items[items.length - 1];
  return { items, nextCursor: start + limit < sorted.length && last !== undefined ? encodeCursor(keyOf(last)) : null };
}
