import { sql, type Kysely, type SqlBool } from 'kysely';
import { can, isAdmin, type BulkToolsBody, type DefinitionDiff, type ListToolsQuery, type ToolDetail, type ToolRow, type ToolVersion, type UpdateToolBody } from '@neurouter/shared';
import type { AuditRecorder } from '../audit/recorder.js';
import type { MainDB } from '../db/schema.js';
import type { Dialect } from '../db/url.js';
import type { Clock } from '../lib/clock.js';
import { toIso, toIsoOrNull } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { fromBool, parseJsonColumn, toBool, toJsonColumn } from '../lib/json.js';
import { applyKeyset, containsCi, keysetPage, type KeysetSpec } from '../lib/keyset.js';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination.js';
import type { UserSubject } from '../identity/principal.js';
import type { CatalogEvents } from './events.js';
import { searchTextOf, type ToolDefinition } from './tool-hash.js';
import { updateIndexedTool } from './tools.repo.js';

type ToolJoined = Awaited<ReturnType<ReturnType<ToolsService['base']>['execute']>>[number];

export function reviewState(t: { status: string; pinned_hash: string | null }): ToolRow['reviewState'] {
  if (t.status === 'active') return 'approved';
  if (t.status === 'rejected') return 'rejected';
  if (t.status === 'removed') return t.pinned_hash ? 'approved' : 'pending_review';
  return 'pending_review';
}

/** Tool review, policy and pinning (backend §6 "Approve", §14.3 tools). */
export class ToolsService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly dialect: Dialect,
    private readonly clock: Clock,
    private readonly audit: AuditRecorder,
    private readonly events: CatalogEvents,
  ) {}

  private scope(viewer: UserSubject) {
    const all = isAdmin(viewer) || viewer.roles.includes('auditor');
    return all ? sql<SqlBool>`1 = 1` : viewer.ownedServerIds.length ? sql<SqlBool>`t.server_id in (${sql.join(viewer.ownedServerIds)})` : sql<SqlBool>`1 = 0`;
  }

  private base() {
    return this.db.selectFrom('tools as t').innerJoin('servers as s', 's.id', 't.server_id').selectAll('t').select(['s.name as server_name', 's.slug as server_slug', 's.trusted as server_trusted']);
  }

  private toRow(t: ToolJoined): ToolRow {
    const rl = parseJsonColumn<{ perMinute: number; burst: number }>(t.rate_limit);
    return {
      id: t.id,
      server: { id: t.server_id, name: t.server_name, slug: t.server_slug },
      name: t.upstream_name,
      qualifiedName: t.exposed_name,
      title: t.title,
      description: t.description,
      enabled: toBool(t.enabled),
      requiresApproval: toBool(t.requires_approval),
      reviewState: reviewState(t),
      upstreamPresent: t.status !== 'removed',
      rateLimit: rl ? { perMinute: rl.perMinute, burst: rl.burst } : null,
      // call statistics come from the audit/rollup pipeline (Phase 1 steps 5–6)
      calls24h: 0,
      lastCalledAt: null,
    };
  }

  async list(q: ListToolsQuery, viewer: UserSubject): Promise<{ items: ToolRow[]; nextCursor: string | null }> {
    if (!can(viewer, 'tools:read')) throw AppError.forbidden();
    const limit = clampLimit(q.limit);
    let qb = this.base().where(this.scope(viewer)).where('s.status', '!=', 'disabled');
    if (q.q) qb = qb.where((eb) => eb.or([containsCi(eb.ref('t.exposed_name'), q.q!), containsCi(eb.ref('t.title'), q.q!), containsCi(eb.ref('t.description'), q.q!)]));
    if (q.serverId?.length) qb = qb.where('t.server_id', 'in', q.serverId);
    if (q.status === 'pending_review') qb = qb.where('t.status', 'in', ['pending_review', 'changed']);
    else if (q.status === 'enabled') qb = qb.where('t.status', '=', 'active').where('t.enabled', '=', 1);
    else if (q.status === 'disabled') qb = qb.where((eb) => eb.or([eb('t.enabled', '=', 0), eb('t.status', 'in', ['removed', 'rejected'])]));
    if (q.requiresApproval !== undefined) qb = qb.where('t.requires_approval', '=', fromBool(q.requiresApproval));
    // calls24h / lastCalledAt are 0 / null until rollups land; they sort like name
    const spec: KeysetSpec = { sortExpr: sql<string>`lower(t.exposed_name)`, idExpr: sql<string>`t.id`, order: q.sort && q.sort !== 'name' ? (q.order ?? 'desc') : (q.order ?? 'asc'), kind: 'string' };
    const rows = await applyKeyset(qb, spec, q.cursor, limit).execute();
    return keysetPage(rows, limit, (r) => this.toRow(r), (r) => [r.exposed_name.toLowerCase(), r.id]);
  }

  private async load(id: string, viewer: UserSubject): Promise<ToolJoined> {
    const t = await this.base().where('t.id', '=', id).where(this.scope(viewer)).executeTakeFirst();
    if (!t) throw AppError.notFound('Tool');
    return t;
  }

  private assertWrite(t: { server_id: string }, viewer: UserSubject): void {
    if (!can(viewer, 'tools:write', { serverId: t.server_id })) throw AppError.forbidden();
  }

  async get(id: string, viewer: UserSubject): Promise<ToolDetail> {
    if (!can(viewer, 'tools:read')) throw AppError.forbidden();
    const t = await this.load(id, viewer);
    const pinnedBy = t.approved_by ? await this.db.selectFrom('users').select(['id', 'name']).where('id', '=', t.approved_by).executeTakeFirst() : undefined;
    const trusted = toBool(t.server_trusted);
    const writable = can(viewer, 'tools:write', { serverId: t.server_id });
    const pending = t.pending_hash !== null && (t.status === 'pending_review' || t.status === 'changed');
    return {
      ...this.toRow(t),
      inputSchema: parseJsonColumn<Record<string, unknown>>(t.input_schema) ?? {},
      outputSchema: parseJsonColumn(t.output_schema),
      annotations: parseJsonColumn(t.annotations),
      annotationsTrusted: trusted,
      pinnedHash: t.pinned_hash,
      pinnedAt: toIsoOrNull(t.pinned_hash ? t.approved_at : null),
      pinnedBy: t.pinned_hash && pinnedBy ? pinnedBy : null,
      approvalTimeoutSec: t.approval_timeout_sec,
      hasPendingChange: pending,
      actions: writable ? ['update', ...(pending ? ['approve_definition', 'reject_definition'] : [])] : [],
    };
  }

  async update(id: string, body: UpdateToolBody, viewer: UserSubject): Promise<ToolDetail> {
    const t = await this.load(id, viewer);
    this.assertWrite(t, viewer);
    if (body.enabled === true && (t.status === 'pending_review' || t.status === 'rejected')) throw AppError.conflict('Approve the tool definition before enabling it');
    const patch: Record<string, unknown> = { updated_at: this.clock.now() };
    if (body.enabled !== undefined) patch.enabled = fromBool(body.enabled);
    if (body.requiresApproval !== undefined) patch.requires_approval = fromBool(body.requiresApproval);
    if (body.approvalTimeoutSec !== undefined) patch.approval_timeout_sec = body.approvalTimeoutSec;
    if (body.rateLimit !== undefined) patch.rate_limit = body.rateLimit ? toJsonColumn(body.rateLimit) : null;
    await this.db.updateTable('tools').set(patch as never).where('id', '=', id).execute();
    this.audit.admin({
      actorUserId: viewer.id,
      action: 'tool.update',
      targetType: 'tool',
      targetId: id,
      before: { enabled: toBool(t.enabled), requiresApproval: toBool(t.requires_approval), approvalTimeoutSec: t.approval_timeout_sec, rateLimit: parseJsonColumn(t.rate_limit) },
      after: body,
    });
    await this.events.toolsChanged();
    return this.get(id, viewer);
  }

  async bulk(body: BulkToolsBody, viewer: UserSubject): Promise<{ updated: number; skipped: { id: string; reason: string }[] }> {
    const ids = [...new Set(body.ids)];
    const rows = await this.base().where('t.id', 'in', ids).where(this.scope(viewer)).execute();
    const skipped: { id: string; reason: string }[] = [];
    const toUpdate: string[] = [];
    for (const id of ids) {
      const t = rows.find((r) => r.id === id);
      if (!t) skipped.push({ id, reason: 'not_found' });
      else if (!can(viewer, 'tools:write', { serverId: t.server_id })) skipped.push({ id, reason: 'forbidden' });
      else if (body.patch.enabled === true && (t.status === 'pending_review' || t.status === 'rejected')) skipped.push({ id, reason: 'pending_review' });
      else toUpdate.push(id);
    }
    if (!can(viewer, 'tools:write')) throw AppError.forbidden();
    const patch: Record<string, unknown> = { updated_at: this.clock.now() };
    if (body.patch.enabled !== undefined) patch.enabled = fromBool(body.patch.enabled);
    if (body.patch.requiresApproval !== undefined) patch.requires_approval = fromBool(body.patch.requiresApproval);
    if (toUpdate.length) await this.db.updateTable('tools').set(patch as never).where('id', 'in', toUpdate).execute();
    this.audit.admin({ actorUserId: viewer.id, action: 'tool.bulk_update', targetType: 'tool', targetId: null, after: { ids: toUpdate, patch: body.patch } });
    if (toUpdate.length) await this.events.toolsChanged();
    return { updated: toUpdate.length, skipped };
  }

  async diff(id: string, viewer: UserSubject): Promise<DefinitionDiff> {
    if (!can(viewer, 'tools:read')) throw AppError.forbidden();
    const t = await this.load(id, viewer);
    const versions = await this.db.selectFrom('tool_versions').selectAll().where('tool_id', '=', id).execute();
    const snap = (def: ToolDefinition, hash: string) => ({ hash, title: def.title, description: def.description, inputSchema: def.inputSchema, outputSchema: def.outputSchema, annotations: def.annotations });
    let pinned: DefinitionDiff['pinned'] = null;
    if (t.pinned_hash) {
      const v = versions.find((x) => x.hash === t.pinned_hash);
      const def = v ? parseJsonColumn<ToolDefinition>(v.definition)! : this.columnsDef(t);
      const by = t.approved_by ? await this.db.selectFrom('users').select(['id', 'name']).where('id', '=', t.approved_by).executeTakeFirst() : undefined;
      pinned = { ...snap(def, t.pinned_hash), pinnedAt: toIso(t.approved_at ?? v?.decided_at ?? t.first_seen_at), pinnedBy: by ?? { id: 'system', name: 'Auto-approved' } };
    }
    const currentHash = t.pending_hash ?? t.pinned_hash ?? '';
    const cv = versions.find((x) => x.hash === currentHash);
    const currentDef = t.pending_definition ? parseJsonColumn<ToolDefinition>(t.pending_definition)! : cv ? parseJsonColumn<ToolDefinition>(cv.definition)! : this.columnsDef(t);
    return { pinned, current: { ...snap(currentDef, currentHash), detectedAt: toIso(cv?.first_seen_at ?? t.last_seen_at) } };
  }

  private columnsDef(t: ToolJoined): ToolDefinition {
    return {
      name: t.upstream_name,
      title: t.title,
      description: t.description,
      inputSchema: parseJsonColumn<Record<string, unknown>>(t.input_schema) ?? {},
      outputSchema: parseJsonColumn(t.output_schema),
      annotations: parseJsonColumn(t.annotations),
      execution: parseJsonColumn(t.execution),
    };
  }

  /** CAS on `pending_hash = :hash` → pin it, apply the definition, status active (409 when stale). */
  async approve(id: string, hash: string, viewer: UserSubject): Promise<ToolDetail> {
    const t = await this.load(id, viewer);
    this.assertWrite(t, viewer);
    if (!t.pending_hash || t.pending_hash !== hash || !t.pending_definition) throw AppError.conflict('The definition changed since you reviewed it; reload and review again');
    const def = parseJsonColumn<ToolDefinition>(t.pending_definition)!;
    const now = this.clock.now();
    const ok = await this.db.transaction().execute(async (trx) => {
      const cas = await trx
        .updateTable('tools')
        .set({ pinned_hash: hash, pending_hash: null, pending_definition: null, status: 'active', approved_by: viewer.id, approved_at: now, updated_at: now, ...(t.pinned_hash === null ? { enabled: 1 } : {}) })
        .where('id', '=', id)
        .where('pending_hash', '=', hash)
        .executeTakeFirst();
      if (!Number(cas.numUpdatedRows)) return false;
      await updateIndexedTool(trx, this.dialect, { ...t, title: t.title, description: t.description, search_text: t.search_text }, {
        title: def.title,
        description: def.description,
        input_schema: toJsonColumn(def.inputSchema),
        output_schema: def.outputSchema ? toJsonColumn(def.outputSchema) : null,
        annotations: def.annotations ? toJsonColumn(def.annotations) : null,
        execution: def.execution ? toJsonColumn(def.execution) : null,
        search_text: searchTextOf(def),
      });
      await trx.updateTable('tool_versions').set({ decision: 'superseded' }).where('tool_id', '=', id).where('decision', '=', 'approved').execute();
      await trx.updateTable('tool_versions').set({ decision: 'approved', decided_by: viewer.id, decided_at: now }).where('tool_id', '=', id).where('hash', '=', hash).execute();
      return true;
    });
    if (!ok) throw AppError.conflict('The definition changed since you reviewed it; reload and review again');
    this.audit.admin({ actorUserId: viewer.id, action: 'tool.definition.approve', targetType: 'tool', targetId: id, before: { pinnedHash: t.pinned_hash }, after: { pinnedHash: hash } });
    await this.events.toolsChanged();
    return this.get(id, viewer);
  }

  /** The tool stays blocked; `reviewState` is `rejected` until a new definition appears. */
  async reject(id: string, note: string | undefined, viewer: UserSubject): Promise<ToolDetail> {
    const t = await this.load(id, viewer);
    this.assertWrite(t, viewer);
    if (t.status !== 'pending_review' && t.status !== 'changed') throw AppError.conflict('There is no pending definition to reject');
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('tools').set({ status: 'rejected', updated_at: now }).where('id', '=', id).execute();
      if (t.pending_hash) await trx.updateTable('tool_versions').set({ decision: 'rejected', decided_by: viewer.id, decided_at: now }).where('tool_id', '=', id).where('hash', '=', t.pending_hash).where('decision', '=', 'pending').execute();
    });
    this.audit.admin({ actorUserId: viewer.id, action: 'tool.definition.reject', targetType: 'tool', targetId: id, after: { hash: t.pending_hash, note: note ?? null } });
    await this.events.toolsChanged();
    return this.get(id, viewer);
  }

  async versions(id: string, q: { cursor?: string | undefined; limit?: number | undefined }, viewer: UserSubject): Promise<{ items: ToolVersion[]; nextCursor: string | null }> {
    if (!can(viewer, 'tools:read')) throw AppError.forbidden();
    await this.load(id, viewer);
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    let qb = this.db.selectFrom('tool_versions as v').leftJoin('users as u', 'u.id', 'v.decided_by').select(['v.id', 'v.hash', 'v.first_seen_at', 'v.decision', 'v.decided_at', 'u.id as uid', 'u.name as uname']).where('v.tool_id', '=', id);
    if (key) qb = qb.where((eb) => eb.or([eb('v.first_seen_at', '<', key[0] as number), eb.and([eb('v.first_seen_at', '=', key[0] as number), eb('v.id', '<', key[1] as string)])]));
    const rows = await qb.orderBy('v.first_seen_at', 'desc').orderBy('v.id', 'desc').limit(limit + 1).execute();
    const more = rows.length > limit;
    const slice = rows.slice(0, limit);
    return {
      items: slice.map((r) => ({ id: r.id, hash: r.hash, firstSeenAt: toIso(r.first_seen_at), decision: r.decision, decidedBy: r.uid ? { id: r.uid, name: r.uname ?? '' } : null, decidedAt: toIsoOrNull(r.decided_at) })),
      nextCursor: more ? encodeCursor([slice[slice.length - 1]!.first_seen_at, slice[slice.length - 1]!.id]) : null,
    };
  }
}
