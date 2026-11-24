import * as z from 'zod';
import { AccessRequestStatus, TargetType } from '../domain/enums.js';
import { CursorQuery, Id, IdParams, IsoDateTime, IsoDateTimeInput, Page, Ref, queryOptional } from './common.js';
import { Grant, SubjectInput, TargetInput } from './grants.js';
import { endpoint } from './endpoint.js';

export const AccessRequest = z.object({
  id: Id,
  requester: Ref,
  agent: Ref.nullable(),
  target: z.object({ type: TargetType, id: Id, name: z.string(), server: Ref }),
  reason: z.string(),
  status: AccessRequestStatus,
  reviewer: Ref.nullable(),
  note: z.string().nullable(),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
  grantId: Id.nullable(),
});
export type AccessRequest = z.infer<typeof AccessRequest>;

export const ACCESS_REQUEST_REASON_MIN = 10;
export const ACCESS_REQUEST_REASON_MAX = 1000;

export const CreateAccessRequestBody = z.object({
  target: TargetInput,
  reason: z.string().trim().min(ACCESS_REQUEST_REASON_MIN).max(ACCESS_REQUEST_REASON_MAX),
  agentId: Id.optional(),
});
export type CreateAccessRequestBody = z.infer<typeof CreateAccessRequestBody>;

export const ListMyAccessRequestsQuery = CursorQuery.extend({ status: queryOptional(AccessRequestStatus) });
export type ListMyAccessRequestsQuery = z.infer<typeof ListMyAccessRequestsQuery>;

/** Review queue status filter: one status, or `resolved` (anything decided: approved, denied or cancelled). */
export const AccessRequestQueueStatus = z.enum([...AccessRequestStatus.options, 'resolved']);
export type AccessRequestQueueStatus = z.infer<typeof AccessRequestQueueStatus>;

/** Review queue: default `pending`, oldest first; decided requests newest first. */
export const ListAccessRequestsQuery = CursorQuery.extend({
  status: queryOptional(AccessRequestQueueStatus),
  serverId: queryOptional(Id),
});
export type ListAccessRequestsQuery = z.infer<typeof ListAccessRequestsQuery>;

export const ApproveAccessRequestBody = z.object({
  grantSubject: SubjectInput.optional(),
  /** may narrow server → tool */
  target: TargetInput.optional(),
  expiresAt: IsoDateTimeInput.nullable().optional(),
  note: z.string().max(1000).optional(),
});
export type ApproveAccessRequestBody = z.infer<typeof ApproveAccessRequestBody>;
export const ApproveAccessRequestResponse = z.object({ request: AccessRequest, grant: Grant });
export type ApproveAccessRequestResponse = z.infer<typeof ApproveAccessRequestResponse>;

export const DenyAccessRequestBody = z.object({ note: z.string().trim().min(1).max(1000) });
export type DenyAccessRequestBody = z.infer<typeof DenyAccessRequestBody>;

export const accessRequestEndpoints = {
  create: endpoint({
    method: 'POST', path: '/api/access-requests', kind: 'json', status: 201, access: ['user'],
    summary: 'Request access (409 if a pending duplicate exists)', body: CreateAccessRequestBody, response: AccessRequest,
  }),
  listMine: endpoint({
    method: 'GET', path: '/api/me/access-requests', kind: 'json', access: ['user'],
    summary: 'My access requests', query: ListMyAccessRequestsQuery, response: Page(AccessRequest),
  }),
  cancelMine: endpoint({
    method: 'DELETE', path: '/api/me/access-requests/:id', kind: 'empty', access: ['self'],
    summary: 'Cancel a pending request (409 if decided)', params: IdParams,
  }),
  list: endpoint({
    method: 'GET', path: '/api/access-requests', kind: 'json', access: ['owner', 'auditor'],
    summary: 'Review queue', query: ListAccessRequestsQuery, response: Page(AccessRequest),
  }),
  approve: endpoint({
    method: 'POST', path: '/api/access-requests/:id/approve', kind: 'json', access: ['owner'],
    summary: 'Approve and create a grant (409 if decided)', params: IdParams, body: ApproveAccessRequestBody, response: ApproveAccessRequestResponse,
  }),
  deny: endpoint({
    method: 'POST', path: '/api/access-requests/:id/deny', kind: 'json', access: ['owner'],
    summary: 'Deny a request', params: IdParams, body: DenyAccessRequestBody, response: AccessRequest,
  }),
} as const;
