import { sql, type Kysely, type SqlBool } from 'kysely';
import type { ListSessionsQuery, Session, SessionDetail, SessionEvent } from '@neurouter/shared';
import { resolveScope, type ResolvedScope } from '../api/scope.js';
import { DELETED, upstreamNameOf, type NameMaps, type NameResolver } from '../audit/names.js';
import type { AuditStore } from '../audit/store.js';
import type { AuditDB, McpSessionsTable } from '../db/schema.js';
import type { Dialect } from '../db/url.js';
import type { UserSubject } from '../identity/principal.js';
import { fromIso, toIso, type Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { parseJsonColumn } from '../lib/json.js';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination.js';
import { LIVE_SESSION_MS } from './sessions.js';

type Row = Omit<McpSessionsTable, 'calls' | 'errors' | 'blocked' | 'servers'> & { calls: number; errors: number; blocked: number; servers: unknown };

/** Sessions REST (§14.3 Observability) with the same owner / `scope=me` scoping as audit. */
export class SessionsService {
  constructor(
    private readonly db: Kysely<AuditDB>,
    private readonly dialect: Dialect,
    private readonly store: AuditStore,
    private readonly names: NameResolver,
    private readonly clock: Clock,
  ) {}

  /** Sessions that touched any of the servers (owner scope). */
  private touches(serverIds: readonly string[]) {
    if (!serverIds.length) return sql<SqlBool>`1 = 0`;
    return this.dialect === 'postgres'
      ? sql<SqlBool>`mcp_sessions.servers ?| array[${sql.join(serverIds)}]::text[]`
      : sql<SqlBool>`exists (select 1 from json_each(mcp_sessions.servers) j where j.value in (${sql.join(serverIds)}))`;
  }

  private visible(scope: ResolvedScope, r: Row): boolean {
    if (scope.userId && r.user_id !== scope.userId) return false;
    if (scope.serverIds) {
      const servers = parseJsonColumn<string[]>(r.servers) ?? [];
      if (!servers.some((s) => scope.serverIds!.includes(s))) return false;
    }
    return true;
  }

  private toSession(r: Row, m: NameMaps): Session {
    const last = Number(r.last_seen_at);
    return {
      id: r.id,
      source: r.source,
      agent: { id: r.agent_id, name: m.agents.get(r.agent_id) ?? DELETED },
      user: { id: r.user_id, name: m.users.get(r.user_id)?.name ?? DELETED },
      client: r.client_name ? { name: r.client_name } : null,
      startedAt: toIso(Number(r.first_seen_at)),
      lastActivityAt: toIso(last),
      callCount: Number(r.calls),
      errorCount: Number(r.errors),
      blockedCount: Number(r.blocked),
      active: last > this.clock.now() - LIVE_SESSION_MS,
    };
  }

  async list(q: ListSessionsQuery, viewer: UserSubject): Promise<{ items: Session[]; nextCursor: string | null }> {
    const scope = resolveScope(viewer, 'sessions:read', { userId: q.userId });
    const from = fromIso(q.from);
    const to = fromIso(q.to);
    if (to <= from) throw AppError.validation('`to` must be after `from`', [{ path: ['to'], message: 'Must be after from', code: 'invalid_range' }]);
    const limit = clampLimit(q.limit);
    let qb = this.db.selectFrom('mcp_sessions').selectAll().where('first_seen_at', '<', to).where('last_seen_at', '>=', from);
    const userId = scope.userId ?? q.userId;
    if (userId) qb = qb.where('user_id', '=', userId);
    if (q.agentId) qb = qb.where('agent_id', '=', q.agentId);
    if (scope.serverIds) qb = qb.where(this.touches(scope.serverIds));
    if (q.active === true) qb = qb.where('last_seen_at', '>', this.clock.now() - LIVE_SESSION_MS);
    if (q.active === false) qb = qb.where('last_seen_at', '<=', this.clock.now() - LIVE_SESSION_MS);
    const key = decodeCursor(q.cursor);
    if (key) {
      const [ls, id] = key;
      if (typeof ls !== 'number' || typeof id !== 'string') throw AppError.validation('Invalid cursor', [{ path: ['cursor'], message: 'Invalid cursor', code: 'invalid_cursor' }]);
      qb = qb.where((eb) => eb.or([eb('last_seen_at', '<', ls), eb.and([eb('last_seen_at', '=', ls), eb('id', '<', id)])]));
    }
    const rows = (await qb.orderBy('last_seen_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute()) as unknown as Row[];
    const page = rows.slice(0, limit);
    const m = await this.names.load({ users: page.map((r) => r.user_id), agents: page.map((r) => r.agent_id) });
    const last = page[page.length - 1];
    return { items: page.map((r) => this.toSession(r, m)), nextCursor: rows.length > limit && last ? encodeCursor([Number(last.last_seen_at), last.id]) : null };
  }

  private async load(id: string, viewer: UserSubject): Promise<{ row: Row; scope: ResolvedScope }> {
    const scope = resolveScope(viewer, 'sessions:read', {});
    const row = (await this.db.selectFrom('mcp_sessions').selectAll().where('id', '=', id).executeTakeFirst()) as unknown as Row | undefined;
    if (!row || !this.visible(scope, row)) throw AppError.notFound('Session');
    return { row, scope };
  }

  async get(id: string, viewer: UserSubject): Promise<SessionDetail> {
    const { row, scope } = await this.load(id, viewer);
    const m = await this.names.load({ users: [row.user_id], agents: [row.agent_id] });
    const perMinute = await this.store.countsByMinute({
      from: Number(row.first_seen_at),
      to: Number(row.last_seen_at) + 1,
      sessionId: id,
      kinds: ['tool_call'],
      ...(scope.serverIds ? { serverIds: scope.serverIds } : {}),
    });
    return { ...this.toSession(row, m), perMinute: perMinute.map((p) => ({ t: toIso(p.t), calls: p.calls })) };
  }

  async events(id: string, q: { cursor?: string | undefined; limit?: number | undefined }, viewer: UserSubject): Promise<{ items: SessionEvent[]; nextCursor: string | null }> {
    const { row, scope } = await this.load(id, viewer);
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    if (key && typeof key[0] !== 'number') throw AppError.validation('Invalid cursor', [{ path: ['cursor'], message: 'Invalid cursor', code: 'invalid_cursor' }]);
    const { rows, nextSeq } = await this.store.query({
      from: Number(row.first_seen_at),
      to: Number(row.last_seen_at) + 1,
      sessionId: id,
      kinds: ['tool_call'],
      order: 'asc',
      limit,
      cursorSeq: key ? (key[0] as number) : null,
      ...(scope.serverIds ? { serverIds: scope.serverIds } : {}),
    });
    const m = await this.names.load({ servers: rows.map((r) => r.server_id) });
    return {
      items: rows.map((r) => {
        const s = r.server_id ? m.servers.get(r.server_id) : undefined;
        return {
          auditEventId: r.id,
          ts: toIso(Number(r.ts)),
          server: r.server_id ? { id: r.server_id, name: s?.name ?? DELETED, slug: s?.slug ?? '' } : { id: 'unknown', name: '(unknown tool)', slug: '' },
          tool: { qualifiedName: r.tool_name ?? upstreamNameOf('') },
          decision: r.decision,
          status: r.status,
          latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
        };
      }),
      nextCursor: nextSeq === null ? null : encodeCursor([nextSeq]),
    };
  }
}
