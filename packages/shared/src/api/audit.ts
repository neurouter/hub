import * as z from 'zod';
import { AuditDecision, AuditKind, AuditStatus } from '../domain/enums.js';
import {
  ClientInfo, CursorQuery, DEFAULT_AUDIT_MAX_RANGE_DAYS, Id, IdParams, IsoDateTime, IsoDateTimeInput, JobAccepted, JsonObject, Page, Ref,
  ServerRef, ToolNameRef, queryArray, queryOptional, timeRangeIssue,
} from './common.js';
import { endpoint } from './endpoint.js';

export const AuditEvent = z.object({
  id: Id,
  seq: z.number().int().nonnegative(),
  ts: IsoDateTime,
  kind: AuditKind,
  user: Ref.nullable(),
  agent: Ref.nullable(),
  client: ClientInfo.nullable(),
  server: ServerRef.nullable(),
  tool: ToolNameRef.nullable(),
  decision: AuditDecision,
  decisionReason: z.string().nullable(),
  status: AuditStatus,
  latencyMs: z.number().int().nonnegative().nullable(),
  errorMessage: z.string().nullable(),
  traceId: z.string().nullable(),
  sessionId: Id.nullable(),
  adminAction: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditEventFull = AuditEvent.extend({
  inputParams: JsonObject.nullable(),
  outputSize: z.number().int().nonnegative().nullable(),
  outputHash: z.string().nullable(),
  output: z.unknown().nullable(),
  error: z.object({ code: z.string(), message: z.string(), detail: z.string().nullable() }).nullable(),
  hash: z.string(),
  prevHash: z.string(),
  protocolVersion: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  admin: z
    .object({
      action: z.string(),
      target: z.object({ type: z.string(), id: Id, name: z.string() }),
      before: JsonObject.nullable(),
      after: JsonObject.nullable(),
    })
    .nullable(),
});
export type AuditEventFull = z.infer<typeof AuditEventFull>;

/**
 * Audit filters. `from`/`to` are REQUIRED (backend addendum 4 / frontend addendum 8): unbounded
 * queries are rejected with 422, and the range may not exceed 31 days by default.
 */
export const AuditFilterFields = z.object({
  from: IsoDateTimeInput,
  to: IsoDateTimeInput,
  userId: queryOptional(Id),
  agentId: queryOptional(Id),
  serverId: queryOptional(Id),
  toolId: queryOptional(Id),
  decision: queryArray(AuditDecision),
  status: queryArray(AuditStatus),
  kind: queryArray(AuditKind),
  q: queryOptional(z.string().max(500)),
  sessionId: queryOptional(Id),
  traceId: queryOptional(z.string().max(64)),
  scope: queryOptional(z.literal('me')),
});

function withRangeCheck<T extends z.ZodType<{ from: string; to: string }>>(schema: T) {
  return schema.superRefine((v, ctx) => {
    const issue = timeRangeIssue(v.from, v.to, DEFAULT_AUDIT_MAX_RANGE_DAYS);
    if (issue) ctx.addIssue({ code: 'custom', path: ['to'], message: issue });
  });
}

export const AuditEventsQuery = withRangeCheck(AuditFilterFields.extend(CursorQuery.shape));
export type AuditEventsQuery = z.infer<typeof AuditEventsQuery>;

export const AuditExportFormat = z.enum(['csv', 'json']);
export const AuditExportQuery = withRangeCheck(AuditFilterFields.extend({ format: AuditExportFormat }));
export type AuditExportQuery = z.infer<typeof AuditExportQuery>;
export const AUDIT_EXPORT_ROW_CAP = 1_000_000;
export const AUDIT_EXPORT_TRUNCATED_HEADER = 'X-Neurouter-Truncated';

export const VerifyAuditBody = z.object({ from: IsoDateTimeInput.optional(), to: IsoDateTimeInput.optional() });
export type VerifyAuditBody = z.infer<typeof VerifyAuditBody>;

/** `Job.result` of an `audit_verify` job. */
export const AuditVerifyResult = z.object({
  ok: z.boolean(),
  checked: z.number().int().nonnegative(),
  firstSeq: z.number().int().nullable(),
  lastSeq: z.number().int().nullable(),
  checkpointsVerified: z.number().int().nonnegative(),
  brokenAt: z
    .object({
      seq: z.number().int(),
      eventId: Id.nullable(),
      reason: z.enum(['hash_mismatch', 'gap', 'bad_checkpoint_mac', 'checkpoint_mismatch', 'broken_link']),
      expected: z.string().nullable(),
      actual: z.string().nullable(),
    })
    .nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type AuditVerifyResult = z.infer<typeof AuditVerifyResult>;

export const auditEndpoints = {
  events: endpoint({
    method: 'GET', path: '/api/audit/events', kind: 'json', access: ['auditor', 'owner', 'user'],
    summary: 'Search audit events (time range required; owners scoped; users scope=me)', query: AuditEventsQuery, response: Page(AuditEvent),
  }),
  event: endpoint({
    method: 'GET', path: '/api/audit/events/:id', kind: 'json', access: ['auditor', 'owner', 'user'],
    summary: 'Audit event detail', params: IdParams, response: AuditEventFull,
  }),
  export: endpoint({
    method: 'GET', path: '/api/audit/export', kind: 'download', access: ['auditor', 'owner'],
    summary: 'Streamed CSV / NDJSON export', query: AuditExportQuery,
  }),
  verify: endpoint({
    method: 'POST', path: '/api/audit/verify', kind: 'json', status: 202, access: ['auditor'],
    summary: 'Verify the hash chain (poll /api/jobs/:id)', body: VerifyAuditBody, response: JobAccepted,
  }),
} as const;
