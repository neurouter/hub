import * as z from 'zod';
import { ApprovalStatus, AuthMethod } from '../domain/enums.js';
import { ClientInfo, CursorQuery, Id, IdParams, IsoDateTime, JsonObject, Page, QueryBool, Ref, ServerRef, ToolNameRef, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';

export const Approval = z.object({
  id: Id,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  /** Total hold time, for the countdown bar (frontend addendum #5). */
  timeoutSec: z.number().int().positive(),
  user: Ref,
  agent: Ref,
  client: ClientInfo.nullable(),
  /** `api_key` → the UI shows the agent name plus "API key" as the client (frontend addendum #5). */
  authMethod: AuthMethod,
  /** The API key that made the call (null for OAuth or rows held before keys were recorded). Optional for older servers. */
  apiKey: Ref.nullable().optional(),
  server: ServerRef,
  tool: ToolNameRef,
  /** redacted, with `{"$redacted": rule}` markers */
  inputParams: JsonObject,
  argumentsHash: z.string(),
  status: ApprovalStatus,
  decidedBy: Ref.nullable(),
  decidedAt: IsoDateTime.nullable(),
  reason: z.string().nullable(),
  actions: z.array(z.enum(['approve', 'deny'])),
});
export type Approval = z.infer<typeof Approval>;

export const ListApprovalsQuery = CursorQuery.extend({
  status: queryOptional(z.enum(['pending', 'resolved'])),
  serverId: queryOptional(Id),
  mine: queryOptional(QueryBool),
});
export type ListApprovalsQuery = z.infer<typeof ListApprovalsQuery>;

export const ApproveApprovalBody = z.object({ note: z.string().max(1000).optional() });
export type ApproveApprovalBody = z.infer<typeof ApproveApprovalBody>;
export const DenyApprovalBody = z.object({ reason: z.string().trim().min(1).max(1000) });
export type DenyApprovalBody = z.infer<typeof DenyApprovalBody>;

/** SSE event names on `/api/approvals/stream`; `data` is an `Approval`, `id` is `<updatedAtMs>:<approvalId>`. */
export const APPROVAL_STREAM_EVENTS = ['approval.created', 'approval.resolved', 'approval.expired'] as const;
export const ApprovalStreamEvent = z.enum(APPROVAL_STREAM_EVENTS);
export type ApprovalStreamEvent = z.infer<typeof ApprovalStreamEvent>;

export const approvalEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/approvals', kind: 'json', access: ['owner', 'auditor', 'user'],
    summary: 'Pending / resolved approvals (users: mine=true)', query: ListApprovalsQuery, response: Page(Approval),
  }),
  stream: endpoint({
    method: 'GET', path: '/api/approvals/stream', kind: 'sse', access: ['owner', 'auditor', 'user'],
    summary: 'Live approval events (Last-Event-ID replay)', response: Approval,
  }),
  get: endpoint({
    method: 'GET', path: '/api/approvals/:id', kind: 'json', access: ['owner', 'auditor', 'user'],
    summary: 'Approval detail', params: IdParams, response: Approval,
  }),
  approve: endpoint({
    method: 'POST', path: '/api/approvals/:id/approve', kind: 'json', access: ['owner'],
    summary: 'Approve a held call (409 resolved, 410 expired)', params: IdParams, body: ApproveApprovalBody, response: Approval,
  }),
  deny: endpoint({
    method: 'POST', path: '/api/approvals/:id/deny', kind: 'json', access: ['owner'],
    summary: 'Deny a held call (409 / 410)', params: IdParams, body: DenyApprovalBody, response: Approval,
  }),
} as const;
