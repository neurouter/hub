import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { AUDIT_EXPORT_ROW_CAP, AUDIT_EXPORT_TRUNCATED_HEADER, type AuditEvent, type AuditEventFull, type AuditEventsQuery, type AuditExportQuery, type AuditVerifyResult, type VerifyAuditBody } from '@neurouter/shared';
import { resolveScope, rowVisible, type ResolvedScope } from '../api/scope.js';
import type { UserSubject } from '../identity/principal.js';
import type { JobsService } from '../jobs/jobs.service.js';
import { fromIso, toIso, type Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { parseJsonColumn } from '../lib/json.js';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination.js';
import { csvHeader, csvLine, ndjsonLine } from './export.js';
import { DELETED, type NameResolver, upstreamNameOf, type NameMaps } from './names.js';
import type { AuditRecorder } from './recorder.js';
import type { AuditStore } from './store.js';
import type { AuditQuery, AuditRow } from './types.js';

type Filters = Omit<AuditEventsQuery, 'cursor' | 'limit'>;

const asObject = (v: unknown): Record<string, unknown> | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return { value: v };
};

/** REST over AuditStore: search, detail, export and verify, with forced owner / `scope=me` scoping. */
export class AuditService {
  constructor(
    private readonly store: AuditStore,
    private readonly names: NameResolver,
    private readonly jobs: JobsService,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
  ) {}

  toQuery(f: Filters, scope: ResolvedScope): Omit<AuditQuery, 'limit' | 'cursorSeq'> {
    const q: Omit<AuditQuery, 'limit' | 'cursorSeq'> = { from: fromIso(f.from), to: fromIso(f.to) };
    if (scope.serverIds) q.serverIds = scope.serverIds;
    const userId = scope.userId ?? f.userId;
    if (userId) q.userId = userId;
    if (f.agentId) q.agentId = f.agentId;
    if (f.toolId) q.toolId = f.toolId;
    if (f.decision?.length) q.decisions = f.decision;
    if (f.status?.length) q.statuses = f.status;
    if (f.kind?.length) q.kinds = f.kind;
    if (f.q) q.q = f.q;
    if (f.sessionId) q.sessionId = f.sessionId;
    if (f.traceId) q.traceId = f.traceId;
    return q;
  }

  private async maps(rows: AuditRow[]): Promise<NameMaps> {
    return this.names.load({
      users: rows.map((r) => r.user_id),
      agents: rows.map((r) => r.agent_id),
      servers: rows.map((r) => r.server_id),
      tools: rows.map((r) => r.tool_id),
    });
  }

  toEvent(r: AuditRow, m: NameMaps): AuditEvent {
    const user = r.user_id ? { id: r.user_id, name: m.users.get(r.user_id)?.name ?? DELETED } : null;
    const agent = r.agent_id ? { id: r.agent_id, name: m.agents.get(r.agent_id) ?? DELETED } : null;
    const srv = r.server_id ? m.servers.get(r.server_id) : undefined;
    const tool = r.tool_id ? m.tools.get(r.tool_id) : undefined;
    return {
      id: r.id,
      seq: Number(r.seq),
      ts: toIso(Number(r.ts)),
      kind: r.kind,
      user,
      agent,
      client: r.client_name ? { name: r.client_name, version: r.client_version } : null,
      server: r.server_id ? { id: r.server_id, name: srv?.name ?? DELETED, slug: srv?.slug ?? '' } : null,
      tool: r.tool_name ? { name: tool?.upstreamName ?? upstreamNameOf(r.tool_name), qualifiedName: r.tool_name } : null,
      decision: r.decision,
      decisionReason: r.decision_reason,
      status: r.status,
      latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      errorMessage: r.error_message,
      traceId: r.trace_id,
      sessionId: r.session_id,
      adminAction: r.kind === 'admin' || r.kind === 'auth' || r.kind === 'system' ? r.action : null,
    };
  }

  async events(q: AuditEventsQuery, viewer: UserSubject): Promise<{ items: AuditEvent[]; nextCursor: string | null }> {
    const scope = resolveScope(viewer, 'audit:read', q);
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    if (key && typeof key[0] !== 'number') throw AppError.validation('Invalid cursor', [{ path: ['cursor'], message: 'Invalid cursor', code: 'invalid_cursor' }]);
    const { rows, nextSeq } = await this.store.query({ ...this.toQuery(q, scope), limit, cursorSeq: key ? (key[0] as number) : null });
    const m = await this.maps(rows);
    return { items: rows.map((r) => this.toEvent(r, m)), nextCursor: nextSeq === null ? null : encodeCursor([nextSeq]) };
  }

  async event(id: string, viewer: UserSubject): Promise<AuditEventFull> {
    const scope = resolveScope(viewer, 'audit:read', {});
    const r = await this.store.get(id);
    if (!r || !rowVisible(scope, { serverId: r.server_id, userId: r.user_id })) throw AppError.notFound('Audit event');
    const m = await this.maps([r]);
    const changes = parseJsonColumn<{ before?: unknown; after?: unknown }>(r.changes);
    let admin: AuditEventFull['admin'] = null;
    if (r.kind === 'admin') {
      const name = (await this.names.targetName(r.target_type, r.target_id)) ?? nameFromChanges(changes) ?? r.target_id ?? r.target_type ?? 'unknown';
      admin = {
        action: r.action ?? 'unknown',
        target: { type: r.target_type ?? 'unknown', id: r.target_id ?? r.target_type ?? '-', name },
        before: asObject(changes?.before ?? null),
        after: asObject(changes?.after ?? null),
      };
    }
    return {
      ...this.toEvent(r, m),
      inputParams: asObject(parseJsonColumn(r.params_redacted)),
      outputSize: r.output_size === null ? null : Number(r.output_size),
      outputHash: r.output_hash,
      output: parseJsonColumn(r.output_full),
      error: r.error_code || r.error_message ? { code: r.error_code ?? 'error', message: r.error_message ?? '', detail: null } : null,
      hash: r.hash,
      prevHash: r.prev_hash,
      protocolVersion: r.protocol_version,
      ip: r.ip,
      userAgent: r.user_agent,
      admin,
    };
  }

  /** Streams CSV or NDJSON with backpressure; capped at 1,000,000 rows (header says when truncated). */
  async export(q: AuditExportQuery, viewer: UserSubject, reply: FastifyReply, meta: { ip: string; userAgent: string | null }, cap = AUDIT_EXPORT_ROW_CAP): Promise<FastifyReply> {
    const scope = resolveScope(viewer, 'audit:export', q);
    const query = this.toQuery(q, scope);
    const total = await this.store.count(query, cap);
    const truncated = total > cap;
    this.audit.admin({
      actorUserId: viewer.id,
      action: 'audit.export',
      targetType: 'audit',
      targetId: null,
      after: { format: q.format, from: q.from, to: q.to, scope: scope.mode, filters: summarize(q), rows: Math.min(total, cap), truncated },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const csv = q.format === 'csv';
    const stamp = new Date(this.clock.now()).toISOString().replace(/[:.]/g, '-');
    reply
      .header('content-type', csv ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8')
      .header('content-disposition', `attachment; filename="neurouter-audit-${stamp}.${csv ? 'csv' : 'ndjson'}"`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff');
    if (truncated) reply.header(AUDIT_EXPORT_TRUNCATED_HEADER, 'true');
    const rows = this.store.export(query, cap);
    async function* lines(): AsyncGenerator<string> {
      if (csv) yield csvHeader();
      for await (const r of rows) yield csv ? csvLine(r) : ndjsonLine(r);
    }
    return reply.status(200).send(Readable.from(lines(), { objectMode: false, highWaterMark: 64 * 1024 }));
  }

  /** `POST /api/audit/verify` → 202 + job (runs on this replica). The run itself is audited. */
  async verify(body: VerifyAuditBody, viewer: UserSubject): Promise<{ jobId: string }> {
    const from = body.from ? fromIso(body.from) : undefined;
    const to = body.to ? fromIso(body.to) : undefined;
    if (from !== undefined && to !== undefined && to <= from) throw AppError.validation('`to` must be after `from`', [{ path: ['to'], message: 'Must be after from', code: 'invalid_range' }]);
    const jobId = await this.jobs.start('audit_verify', { from: body.from ?? null, to: body.to ?? null }, viewer.id, async (progress): Promise<AuditVerifyResult> => {
      const started = performance.now();
      await this.store.flush(5_000);
      const range = from !== undefined || to !== undefined ? await this.store.seqRange(from, to) : {};
      if (range === null || (range.fromSeq !== undefined && range.toSeq !== undefined && range.toSeq < range.fromSeq)) {
        const res: AuditVerifyResult = { ok: true, checked: 0, firstSeq: null, lastSeq: null, checkpointsVerified: 0, brokenAt: null, durationMs: Math.round(performance.now() - started) };
        this.audit.system('audit.verify', { reason: 'empty range', changes: res });
        return res;
      }
      const head = await this.store.headSeq();
      const total = Math.max(1, (range.toSeq ?? head) - (range.fromSeq ?? 1) + 1);
      const out = await this.store.verify(range, (checked) => progress(Math.min(0.99, checked / total)));
      const res: AuditVerifyResult = { ...out, durationMs: Math.round(performance.now() - started) };
      this.audit.record({
        kind: 'system',
        userId: viewer.id,
        action: 'audit.verify',
        decision: 'not_applicable',
        status: out.ok ? 'ok' : 'tool_error',
        decisionReason: out.ok ? null : `chain broken at seq ${out.brokenAt?.seq}: ${out.brokenAt?.reason}`,
        changes: { before: null, after: res },
      });
      return res;
    });
    return { jobId };
  }
}

function nameFromChanges(c: { before?: unknown; after?: unknown } | null): string | null {
  for (const v of [c?.after, c?.before]) {
    if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') return (v as { name: string }).name;
  }
  return null;
}

function summarize(q: AuditExportQuery): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['userId', 'agentId', 'serverId', 'toolId', 'decision', 'status', 'kind', 'q', 'sessionId', 'traceId', 'scope'] as const) {
    const v = q[k];
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  }
  return out;
}
