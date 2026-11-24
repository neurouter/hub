import { sql, type Kysely, type Selectable, type SqlBool } from 'kysely';
import { isAdmin, isAuditor, type Approval, type ListApprovalsQuery } from '@neurouter/shared';
import type { AuditRecorder } from '../../audit/recorder.js';
import type { CoordinationStore, Json } from '../../coordination/types.js';
import type { ApprovalsTable, MainDB } from '../../db/schema.js';
import type { UserSubject } from '../../identity/principal.js';
import { toIso, toIsoOrNull, type Clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { parseJsonColumn } from '../../lib/json.js';
import { clampLimit, decodeCursor, encodeCursor } from '../../lib/pagination.js';
import type { SettingsService } from '../../settings/settings.service.js';

export type ApprovalRow = Selectable<ApprovalsTable>;
export type ApprovalState = ApprovalRow['status'];

/** Coordination channels (backend §12.2). */
export const APPROVALS_CHANGED = 'approvals.changed';
export const approvalChannel = (id: string) => `approval:${id}`;

/** Payload published on `approval:<id>` when a decision (or expiry) lands. */
export interface ApprovalSignal {
  status: ApprovalState;
  decidedBy: string | null;
  reason: string | null;
}

export function isResolved(s: ApprovalState): boolean {
  return s !== 'pending';
}

/** Who may see an approval: admins/auditors all, owners their servers, everyone their own agents' calls. */
export function canSeeApproval(viewer: UserSubject, row: Pick<ApprovalRow, 'server_id' | 'user_id'>): boolean {
  return isAdmin(viewer) || isAuditor(viewer) || viewer.ownedServerIds.includes(row.server_id) || row.user_id === viewer.id;
}

/** Who may decide: Admin or the server's owner (auditors are read-only). */
export function canDecideApproval(viewer: UserSubject, row: Pick<ApprovalRow, 'server_id'>): boolean {
  return isAdmin(viewer) || viewer.ownedServerIds.includes(row.server_id);
}

/**
 * Approvals REST (backend §12.2 decision API, §14.3): scoped lists, detail, and atomic
 * compare-and-set decisions that wake the holding replica through the CoordinationStore.
 */
export class ApprovalsService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly coord: CoordinationStore,
    private readonly settings: SettingsService,
    private readonly audit: AuditRecorder,
  ) {}

  async row(id: string): Promise<ApprovalRow | undefined> {
    return this.db.selectFrom('approvals').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** Maps rows to the contract shape (names resolved in one round trip per kind). */
  async toApi(rows: readonly ApprovalRow[], viewer: UserSubject | null): Promise<Approval[]> {
    if (!rows.length) return [];
    const userIds = [...new Set(rows.flatMap((r) => [r.user_id, ...(r.decided_by ? [r.decided_by] : [])]))];
    const keyIds = [...new Set(rows.flatMap((r) => (r.api_key_id ? [r.api_key_id] : [])))];
    const [users, agents, servers, tools, allowSelf, keys] = await Promise.all([
      this.db.selectFrom('users').select(['id', 'name', 'email']).where('id', 'in', userIds).execute(),
      this.db.selectFrom('agents').select(['id', 'name']).where('id', 'in', [...new Set(rows.map((r) => r.agent_id))]).execute(),
      this.db.selectFrom('servers').select(['id', 'name', 'slug']).where('id', 'in', [...new Set(rows.map((r) => r.server_id))]).execute(),
      this.db.selectFrom('tools').select(['id', 'upstream_name', 'exposed_name']).where('id', 'in', [...new Set(rows.map((r) => r.tool_id))]).execute(),
      this.settings.get('allowSelfApproval'),
      keyIds.length ? this.db.selectFrom('api_keys').select(['id', 'name']).where('id', 'in', keyIds).execute() : Promise.resolve([]),
    ]);
    const k = new Map(keys.map((x) => [x.id, x]));
    const u = new Map(users.map((x) => [x.id, x]));
    const a = new Map(agents.map((x) => [x.id, x]));
    const s = new Map(servers.map((x) => [x.id, x]));
    const t = new Map(tools.map((x) => [x.id, x]));
    const now = this.clock.now();
    return rows.map((r) => {
      const user = u.get(r.user_id);
      const tool = t.get(r.tool_id);
      const server = s.get(r.server_id);
      const decider = r.decided_by ? u.get(r.decided_by) : undefined;
      const actionable = viewer !== null && r.status === 'pending' && Number(r.expires_at) > now && canDecideApproval(viewer, r) && (allowSelf || r.user_id !== viewer.id);
      return {
        id: r.id,
        createdAt: toIso(Number(r.created_at)),
        expiresAt: toIso(Number(r.expires_at)),
        timeoutSec: Math.max(1, Math.round((Number(r.expires_at) - Number(r.created_at)) / 1000)),
        user: { id: r.user_id, name: user?.name ?? '(deleted user)' },
        agent: { id: r.agent_id, name: a.get(r.agent_id)?.name ?? '(deleted agent)' },
        client: r.client_name ? { name: r.client_name, version: r.client_version } : null,
        authMethod: r.auth_method,
        apiKey: r.api_key_id ? { id: r.api_key_id, name: k.get(r.api_key_id)?.name ?? '(deleted key)' } : null,
        server: { id: r.server_id, name: server?.name ?? '(deleted server)', slug: server?.slug ?? '' },
        tool: { name: tool?.upstream_name ?? '(deleted tool)', qualifiedName: tool?.exposed_name ?? '' },
        inputParams: parseJsonColumn<Record<string, unknown>>(r.arguments_redacted) ?? {},
        argumentsHash: r.arguments_hash,
        status: r.status,
        decidedBy: r.decided_by ? { id: r.decided_by, name: decider?.name ?? '(deleted user)' } : null,
        decidedAt: toIsoOrNull(r.decided_at === null ? null : Number(r.decided_at)),
        reason: r.reason,
        actions: actionable ? (['approve', 'deny'] as const).slice() : [],
      };
    });
  }

  /** The visibility filter as SQL (same rule as `canSeeApproval`). `mine` narrows to the viewer's own calls. */
  private scope(viewer: UserSubject, mine: boolean) {
    if (mine) return sql<SqlBool>`user_id = ${viewer.id}`;
    if (isAdmin(viewer) || isAuditor(viewer)) return sql<SqlBool>`1 = 1`;
    if (viewer.ownedServerIds.length) return sql<SqlBool>`(server_id in (${sql.join(viewer.ownedServerIds)}) or user_id = ${viewer.id})`;
    return sql<SqlBool>`user_id = ${viewer.id}`;
  }

  async list(q: ListApprovalsQuery, viewer: UserSubject): Promise<{ items: Approval[]; nextCursor: string | null }> {
    const global = isAdmin(viewer) || isAuditor(viewer);
    if (q.serverId && !q.mine && !global && !viewer.ownedServerIds.includes(q.serverId)) throw AppError.forbidden('You can only see approvals for servers you own');
    let qb = this.db.selectFrom('approvals').selectAll().where(this.scope(viewer, q.mine === true));
    if (q.serverId) qb = qb.where('server_id', '=', q.serverId);
    if (q.status === 'pending') qb = qb.where('status', '=', 'pending');
    if (q.status === 'resolved') qb = qb.where('status', '!=', 'pending');
    // pending: oldest first (a queue); otherwise most recently updated first
    const pending = q.status === 'pending';
    const col = pending ? 'created_at' : 'updated_at';
    const order = pending ? 'asc' : 'desc';
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    if (key) {
      const [ts, id] = key;
      if (typeof ts !== 'number' || typeof id !== 'string') throw AppError.validation('Invalid cursor', [{ path: ['cursor'], message: 'Invalid cursor', code: 'invalid_cursor' }]);
      const op = order === 'asc' ? ('>' as const) : ('<' as const);
      qb = qb.where((eb) => eb.or([eb(col, op, ts), eb.and([eb(col, '=', ts), eb('id', op, id)])]));
    }
    const rows = await qb.orderBy(col, order).orderBy('id', order).limit(limit + 1).execute();
    const slice = rows.slice(0, limit);
    const last = slice.at(-1);
    return { items: await this.toApi(slice, viewer), nextCursor: rows.length > limit && last ? encodeCursor([Number(last[col]), last.id]) : null };
  }

  async get(id: string, viewer: UserSubject): Promise<Approval> {
    const r = await this.row(id);
    if (!r || !canSeeApproval(viewer, r)) throw AppError.notFound('Approval');
    return (await this.toApi([r], viewer))[0]!;
  }

  /** Approvals changed after `afterMs` that the viewer may see (SSE `Last-Event-ID` replay). */
  async changedSince(viewer: UserSubject, afterMs: number, afterId: string, limit = 200): Promise<Array<Approval & { updatedAtMs: number }>> {
    const rows = await this.db
      .selectFrom('approvals')
      .selectAll()
      .where(this.scope(viewer, false))
      .where((eb) => eb.or([eb('updated_at', '>', afterMs), eb.and([eb('updated_at', '=', afterMs), eb('id', '>', afterId)])]))
      .orderBy('updated_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    const mapped = await this.toApi(rows, viewer);
    return mapped.map((a, i) => ({ ...a, updatedAtMs: Number(rows[i]!.updated_at) }));
  }

  /**
   * Atomic decision (backend §12.2): `UPDATE … WHERE status='pending' AND expires_at > now`.
   * 409 when already resolved, 410 when expired; then the holder is signalled and it's audited.
   */
  async decide(id: string, decision: 'approved' | 'denied', viewer: UserSubject, text: string | null, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<Approval> {
    const r = await this.row(id);
    if (!r || !canSeeApproval(viewer, r)) throw AppError.notFound('Approval');
    if (!canDecideApproval(viewer, r)) throw AppError.forbidden('Only an Admin or the owner of this server can decide this approval');
    if (r.user_id === viewer.id && !(await this.settings.get('allowSelfApproval'))) throw AppError.forbidden('You cannot approve or deny calls made by your own agents');
    const now = this.clock.now();
    const res = await this.db
      .updateTable('approvals')
      .set({ status: decision, decided_by: viewer.id, decided_at: now, reason: text, updated_at: now })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .where('expires_at', '>', now)
      .executeTakeFirst();
    if (!Number(res.numUpdatedRows)) {
      const cur = (await this.row(id))!;
      if (cur.status === 'pending' || cur.status === 'expired') {
        await this.expire(id, now);
        throw AppError.gone('This approval has expired');
      }
      throw AppError.conflict(`This approval was already ${cur.status}`);
    }
    await this.signal(id, { status: decision, decidedBy: viewer.id, reason: text });
    this.audit.admin({ actorUserId: viewer.id, action: decision === 'approved' ? 'approval.approve' : 'approval.deny', targetType: 'approval', targetId: id, serverId: r.server_id, after: { status: decision, reason: text }, ...meta });
    return this.get(id, viewer);
  }

  /** CAS pending → `to` (expiry / cancel / abandon). Returns true when this call changed it. */
  async transition(id: string, to: 'expired' | 'cancelled' | 'abandoned', now = this.clock.now()): Promise<boolean> {
    const res = await this.db.updateTable('approvals').set({ status: to, decided_at: now, updated_at: now }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
    const changed = Number(res.numUpdatedRows) > 0;
    if (changed) await this.signal(id, { status: to, decidedBy: null, reason: null });
    return changed;
  }

  private async expire(id: string, now: number): Promise<void> {
    await this.transition(id, 'expired', now);
  }

  /** Wakes the holder (`approval:<id>`) and every replica's SSE fan-out (`approvals.changed`). */
  async signal(id: string, s: ApprovalSignal): Promise<void> {
    await this.coord.publish(approvalChannel(id), s as unknown as Json);
    await this.coord.publish(APPROVALS_CHANGED, { id, status: s.status });
  }

  /**
   * Janitor (leader, every 30 s): pending rows whose holder stopped heart-beating (> 60 s) are
   * `abandoned`; pending rows past `expires_at` are `expired`.
   */
  async sweep(now = this.clock.now(), heartbeatGraceMs = 60_000): Promise<{ abandoned: number; expired: number }> {
    const stale = await this.db.selectFrom('approvals').select(['id', 'expires_at', 'heartbeat_at']).where('status', '=', 'pending').where((eb) => eb.or([eb('heartbeat_at', '<', now - heartbeatGraceMs), eb('expires_at', '<=', now)])).execute();
    let abandoned = 0;
    let expired = 0;
    for (const r of stale) {
      const to = Number(r.expires_at) <= now ? 'expired' : 'abandoned';
      if (await this.transition(r.id, to, now)) {
        if (to === 'expired') expired++;
        else abandoned++;
      }
    }
    return { abandoned, expired };
  }

  async pendingCount(): Promise<number> {
    const r = await this.db.selectFrom('approvals').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'pending').executeTakeFirst();
    return Number(r?.n ?? 0);
  }
}
